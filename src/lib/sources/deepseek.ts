/**
 * DeepSeek, as an extractor rather than an oracle.
 *
 * ## The constraint this file is built around
 *
 * `deepseek-chat` has no web access. Asked "what is the mass of HAWK 16A", it
 * answers from training data — which for a satellite launched last month means it
 * either says nothing or invents a plausible number. The second outcome is the
 * dangerous one, because an invented number looks identical to a real one.
 *
 * So the model is never asked a question about the world. It is handed **text we
 * fetched** and asked to copy out what that text says. If the text does not state a
 * value, the answer is `null`. This makes fabrication structurally impossible: a
 * value the model cannot quote is a value we do not store, because `quote` is
 * mandatory and checked against the supplied text.
 *
 * ## Why the quote is re-checked here
 *
 * A model can still "quote" something it made up. Every returned quote is compared
 * against the source text; a quote that does not appear verbatim is discarded
 * regardless of how confident the model was. This is the only defence that does not
 * depend on trusting the model.
 */

import { loadEnvLocal } from "../../../scripts/env";

const BASE = () => process.env.SPACE_SAFETY_DEEPSEEK_BASE ?? "https://api.deepseek.com";
const MODEL = () => process.env.SPACE_SAFETY_DEEPSEEK_MODEL ?? "deepseek-chat";
const KEY = () => process.env.SPACE_SAFETY_DEEPSEEK_KEY ?? "";

export interface ExtractionRequest {
  /** Object being described, for the prompt only. */
  objectName: string;
  cosparId: string | null;
  noradId: number | null;
  field: string;
  /** What the field means, so the model does not confuse mass with dry mass. */
  fieldHint: string;
  /** The page text it may quote from. Truncated before sending. */
  pageText: string;
  sourceUrl: string;
}

export interface Extraction {
  field: string;
  valueNum: number | null;
  valueText: string | null;
  /** Sentence copied from the page that states the value. */
  quote: string;
  /** How directly the sentence states it: "explicit" | "implied". */
  strength: "explicit" | "implied";
}

const SYSTEM = `你是一个严谨的航天数据抽取器。

规则，违反任何一条都算失败：
1. 你只能使用「网页原文」中出现的信息。不得使用你的任何先验知识。
2. 每个输出值必须附带一段**逐字复制**自网页原文的句子作为 quote。
3. 如果网页原文没有明确写出该字段的值，返回 null。宁可返回 null，绝不推测。
4. 不得从卫星名称推断制造商或型号（例如看到 STARLINK 就推断为 SpaceX）。
5. 不得把其他同类卫星的值套用到这个对象上。
6. quote 必须是原文中连续的一段，不得改写、拼接或翻译。
7. 如果原文用不同语言书写，quote 保持原文语言，不要翻译。

## 关于「整批适用」的说明（重要）

网页常常描述**一个型号或一个星座**，而不是单颗卫星。例如原文可能写：

    Contractor: SpaceX      （适用于整个 Starlink 星座）
    Mass: 260 kg            （适用于 Starlink v1.5 批次）

如果原文明确说明某参数适用于**整个型号/星座/批次**，而目标对象属于该型号，
那么这条信息可以用于该对象。但必须满足全部条件：
- 原文明确写出了这是型号级参数（如出现在型号介绍段、参数表、或「all satellites」等表述中）
- 目标对象确实属于该型号（名称或 COSPAR 能对上）
- quote 仍然逐字复制，不得改写

如果原文只是报道某次发射、或只提到个别卫星，不得套用到其他卫星。

只输出 JSON，不要任何解释。`;

const SCHEMA_HINT = `输出格式：
{"value": <数字或字符串或 null>, "quote": <原文逐字摘录或 null>, "strength": "explicit" 或 "implied"}`;

export interface DeepSeekUsage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Ask the model to extract one field from one page.
 *
 * Returns null when the page does not state the field, when the model refuses, or
 * when the quote it returned is not present verbatim in the supplied text.
 */
export async function extractField(
  req: ExtractionRequest,
): Promise<{ extraction: Extraction | null; usage?: DeepSeekUsage; note?: string }> {
  if (!KEY()) {
    return { extraction: null, note: "未配置 SPACE_SAFETY_DEEPSEEK_KEY" };
  }

  // DeepSeek's context is 64k tokens; 40 000 characters is ~13k tokens and keeps a
  // page plus the instructions comfortably inside it.
  const text = req.pageText.slice(0, 40_000);

  const user = `目标对象：${req.objectName}${req.cosparId ? `（COSPAR ${req.cosparId}）` : ""}${
    req.noradId ? `（NORAD ${req.noradId}）` : ""
  }
要抽取的字段：${req.field}
字段含义：${req.fieldHint}

注意：下级原文可能描述的是**整个型号/星座**而非这一颗卫星。
若原文明确给出了适用于整个型号的参数，且该对象属于该型号，可以采用（见系统提示）。
若原文只涉及其他个体、或根本未提及该参数，返回 null。

网页原文（来源 ${req.sourceUrl}）：
"""
${text}
"""

${SCHEMA_HINT}`;

  let res: Response;
  try {
    res = await fetch(`${BASE()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: MODEL(),
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 500,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (err) {
    return { extraction: null, note: `请求失败：${(err as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { extraction: null, note: `HTTP ${res.status} ${body.slice(0, 200)}` };
  }

  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: { prompt_tokens: number; completion_tokens: number };
  };

  const usage = json.usage
    ? { promptTokens: json.usage.prompt_tokens, completionTokens: json.usage.completion_tokens }
    : undefined;

  const content = json.choices?.[0]?.message?.content;
  if (!content) return { extraction: null, usage, note: "模型未返回内容" };

  let parsed: { value?: unknown; quote?: unknown; strength?: unknown };
  try {
    parsed = JSON.parse(content) as typeof parsed;
  } catch {
    return { extraction: null, usage, note: "返回不是合法 JSON" };
  }

  const value = parsed.value ?? null;
  const quote = typeof parsed.quote === "string" ? parsed.quote.trim() : "";

  // No value, or no quote: nothing to store. A value without a quote cannot be
  // reviewed, and an unreviewable value is what this whole layer exists to prevent.
  if (value === null || quote === "") {
    return { extraction: null, usage, note: "原文未写明该字段" };
  }

  // The quote must actually occur in the page. This catches a model that paraphrases
  // or invents, and it is the one check that does not rely on the model's honesty.
  if (!normalise(text).includes(normalise(quote))) {
    return { extraction: null, usage, note: `quote 未在原文中找到：${quote.slice(0, 80)}` };
  }

  const strength = parsed.strength === "implied" ? "implied" : "explicit";

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { extraction: null, usage, note: "数值非法" };
    return {
      extraction: { field: req.field, valueNum: value, valueText: null, quote, strength },
      usage,
    };
  }
  if (typeof value === "string" && value.trim() !== "") {
    return {
      extraction: { field: req.field, valueNum: null, valueText: value.trim(), quote, strength },
      usage,
    };
  }

  return { extraction: null, usage, note: "值类型不支持" };
}

/**
 * Compare text ignoring whitespace and quote style.
 *
 * Pages wrap sentences across lines and use typographic quotes; a verbatim quote
 * copied by the model may differ in whitespace only. Normalising is what lets the
 * check verify *content* rather than formatting, without becoming so lenient that a
 * rewritten sentence passes.
 */
function normalise(s: string): string {
  return s
    .replace(/[\s\u00a0]+/g, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .trim();
}

/** Load `.env.local` then report whether the extractor is usable. */
export function deepSeekReady(): { ready: boolean; reason?: string } {
  loadEnvLocal();
  if (!KEY()) return { ready: false, reason: "未配置 SPACE_SAFETY_DEEPSEEK_KEY" };
  return { ready: true };
}
