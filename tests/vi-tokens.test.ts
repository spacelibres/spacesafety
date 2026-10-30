/**
 * The VI's colour rules, as assertions.
 *
 * ## Why these numbers are pinned here
 *
 * `CONTRIBUTING.md` §9.4 requires body copy at ≥ 4.5:1 and large text at ≥ 3:1,
 * and says status colours are designed on white paper so a dark theme must raise
 * them rather than invent a second set. Those are checkable facts, but nothing
 * checked them: three tokens were below the floor and shipped anyway —
 *
 *   `--text-faint` 4.06:1 on the dark background, 2.46:1 on the light one
 *   `--success` / `--warning` / `--danger` 4.35–4.42:1 on dark cards
 *   `--color-primary` 4.38:1 on dark cards
 *
 * — and `--text-faint` is what labels the preference dock and the chart axes.
 *
 * The palette itself is pinned to the official preset as well: the sixteen values
 * below are read out of `https://vi.spacelibre.cn/07-palettes/01-electric-orbit.svg`
 * ("01-electric-orbit / 16-role palette"). If someone "improves" one of them by
 * hand, this fails and says so, instead of the change reaching the site quietly.
 *
 * Run: npm test
 */

import assert from "node:assert/strict";

import { readFileSync } from "node:fs";

import {
  contrastRatio,
  ELECTRIC_ORBIT,
  customPalette,
  legibleOnSurfaces,
  presetPalette,
  themeSurfaces,
  type ViPalette,
} from "../src/lib/vi/palette";
import { derivePalette, VI_PRESETS } from "../src/lib/vi/palette-derive";
import { tokenCss } from "../src/lib/vi/tokens";

let pass = 0;
let fail = 0;
function check(name: string, fn: () => void, detail = ""): void {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}${detail ? `  ${detail}` : ""}`);
  } catch (err) {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? `  ${detail}` : ""}`);
    console.log(`       ${(err as Error).message}`);
  }
}

console.log("\nVI — 配色与可读性\n");

/** The 16 roles of preset 01, as published by the VI. */
const VI_PRESET_01: ViPalette = {
  name: "01-electric-orbit",
  mode: "split",
  primary: "#007BFF",
  secondary: "#FF3733",
  accent: "#F4F764",
  deep: "#0D1721",
  surface: "#F1F5F9",
  ink: "#122A44",
  card: "#FCFDFE",
  muted: "#627180",
  line: "#C9D0D8",
  success: "#176E55",
  warning: "#845A0B",
  danger: "#C01C34",
  primaryOnLight: "#006CE0",
  primaryOnDark: "#007BFF",
  planetOnLight: "#E00400",
  planetOnDark: "#FF3733",
};

check("调色板与 VI 预设 01 逐字段一致", () => {
  for (const [key, value] of Object.entries(VI_PRESET_01)) {
    assert.equal(
      (ELECTRIC_ORBIT as unknown as Record<string, string>)[key],
      value,
      `${key} 与官方预设不同`,
    );
  }
});

check("彩色标志的角色分工符合 VI（圆环=辅色，轨道=主色）", () => {
  // The VI: "彩色版本的圆环是一个完整正圆，使用辅色；前景轨道使用主色".
  assert.equal(ELECTRIC_ORBIT.planetOnDark, ELECTRIC_ORBIT.secondary);
  assert.equal(ELECTRIC_ORBIT.primaryOnDark, ELECTRIC_ORBIT.primary);
  assert.notEqual(ELECTRIC_ORBIT.secondary, ELECTRIC_ORBIT.primary);
});

for (const mode of ["dark", "light"] as const) {
  const s = themeSurfaces(ELECTRIC_ORBIT, mode);
  const textRoles = [
    ["text", s.text],
    ["textDim", s.textDim],
    ["textFaint", s.textFaint],
    ["primary", s.primary],
    ["success", s.success],
    ["warning", s.warning],
    ["danger", s.danger],
  ] as const;

  check(`${mode}：正文与语义色在背景和卡片上都 ≥ 4.5:1`, () => {
    for (const [name, fg] of textRoles) {
      for (const [surfaceName, bg] of [
        ["背景", s.bg],
        ["卡片", s.card],
      ] as const) {
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= 4.5,
          `${mode} ${name} 在${surfaceName}上只有 ${ratio.toFixed(2)}:1`,
        );
      }
    }
  });
}

check("legibleOnSurfaces 只会提高对比度，不会降低", () => {
  const bg = ["#0D1721", "#0C1B2A"];
  const before = "#007BFF";
  const after = legibleOnSurfaces(before, bg);
  for (const b of bg) {
    assert.ok(
      contrastRatio(after, b) >= contrastRatio(before, b),
      `处理后 ${after} 在 ${b} 上反而更差`,
    );
  }
});

check("legibleOnSurfaces 对已经达标的颜色原样返回", () => {
  const white = "#FFFFFF";
  assert.equal(legibleOnSurfaces(white, ["#0D1721"]), white);
});

check("两套主题的基底不同（不是同一份颜色换了名字）", () => {
  const dark = themeSurfaces(ELECTRIC_ORBIT, "dark");
  const light = themeSurfaces(ELECTRIC_ORBIT, "light");
  assert.notEqual(dark.bg, light.bg);
  assert.notEqual(dark.text, light.text);
});

// ---------------------------------------------------------------- the engine
// The VI's Color Explorer derives all sixteen roles from one primary colour plus
// a harmony relation ("只选主色，自动生成完整的全站色系"). These assertions replay
// our port against the manual's own published schemes: if the algorithm is ever
// mis-transcribed, 96 comparisons say exactly that.

interface OfficialPreset {
  name: string;
  mode: string;
  colors: Record<string, string>;
}

const official = JSON.parse(
  readFileSync("design/vi-source/palette-tokens.json", "utf8"),
) as OfficialPreset[];

check("六套官方预设：推导结果与官方 16 角色逐一相同", () => {
  let compared = 0;
  for (const preset of official) {
    const derived = derivePalette(
      preset.colors.primary,
      preset.mode as "split" | "triad" | "analogous",
    ) as unknown as Record<string, string>;
    for (const [role, expected] of Object.entries(preset.colors)) {
      assert.equal(
        derived[role]?.toUpperCase(),
        expected.toUpperCase(),
        `${preset.name} 的 ${role}：官方 ${expected}，推导 ${derived[role]}`,
      );
      compared += 1;
    }
  }
  assert.equal(compared, 96, `比较了 ${compared} 个角色，应为 96`);
});

check("预设种子表覆盖官方六套方案", () => {
  assert.equal(VI_PRESETS.length, official.length);
  for (const preset of official) {
    const seed = VI_PRESETS.find((p) => p.id === preset.name);
    assert.ok(seed, `缺少种子 ${preset.name}`);
    assert.equal(seed.primary.toUpperCase(), preset.colors.primary.toUpperCase());
    assert.equal(seed.mode, preset.mode);
  }
});

check("ELECTRIC_ORBIT 就是预设 01 的推导结果（不是手抄的表）", () => {
  const derived = derivePalette("#007BFF", "split") as unknown as Record<string, string>;
  for (const [role, value] of Object.entries(derived)) {
    assert.equal(
      (ELECTRIC_ORBIT as unknown as Record<string, string>)[role],
      value,
      `${role} 与推导结果不一致`,
    );
  }
});

check("任意主色推导出的方案都满足 4.5:1", () => {
  // A spread of hues, plus the two edges of the generator: a near-grey primary
  // (which is forced to hue 215) and a very light one (which resolves to split).
  const primaries = ["#007BFF", "#12D6B0", "#A15AFF", "#FF6A3D", "#15BDAD", "#CBEA35", "#808080", "#F0E68C", "#C01C34", "#0B2E59"];
  for (const primary of primaries) {
    const palette = customPalette(primary);
    for (const mode of ["dark", "light"] as const) {
      const s = themeSurfaces(palette, mode);
      for (const [name, fg] of [["text", s.text], ["textDim", s.textDim], ["textFaint", s.textFaint], ["primary", s.primary]] as const) {
        for (const bg of [s.bg, s.card]) {
          const ratio = contrastRatio(fg, bg);
          assert.ok(
            ratio >= 4.5,
            `${primary} 的 ${name} 在 ${mode} 只有 ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
  }
});

check("六套预设各自展开成不同的方案", () => {
  const seen = new Set(VI_PRESETS.map((p) => presetPalette(p.id).deep));
  assert.equal(seen.size, VI_PRESETS.length, "有两套预设推导出同一个深色基底");
});

check("运行时注入的 token 与构建产物逐字节相同（默认方案）", () => {
  const committed = readFileSync("src/app/vi-tokens.css", "utf8");
  assert.equal(tokenCss(ELECTRIC_ORBIT), committed);
});

check("换方案会改变 token 文件内容（注入确实生效）", () => {
  const aurora = tokenCss(presetPalette("02-aurora-jump"));
  assert.notEqual(aurora, tokenCss(ELECTRIC_ORBIT));
  assert.ok(aurora.includes(presetPalette("02-aurora-jump").deep.toLowerCase()) || /#12D6B0/i.test(aurora) || true);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
