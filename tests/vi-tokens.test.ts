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

import {
  contrastRatio,
  ELECTRIC_ORBIT,
  legibleOnSurfaces,
  themeSurfaces,
  type ViPalette,
} from "../src/lib/vi/palette";

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

console.log(`\n${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
