import { describe, expect, it } from "vitest";
import css from "../index.css?raw";

/** Reads the `--ob-*` custom properties declared directly in the first block matching `selector`. */
function tokensIn(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`No block for ${selector}`);
  const open = css.indexOf("{", start + selector.length - 1);
  const close = css.indexOf("}", open);
  const block = css.slice(open + 1, close);
  const tokens: Record<string, string> = {};
  for (const match of block.matchAll(/--ob-([a-z-]+):\s*([^;]+);/g)) tokens[match[1]!] = match[2]!.trim();
  return tokens;
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb colour: ${hex}`);
  const channels = [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const light = tokensIn(":root {");
const darkMedia = tokensIn(':root:not([data-theme="light"]) {');
const darkAttr = tokensIn(':root[data-theme="dark"] {');

/** [foreground, background, minimum ratio]: 4.5 for text (WCAG 1.4.3), 3 for UI parts (1.4.11). */
const PAIRS: [string, string, number][] = [
  ...["bg", "surface", "raised"].flatMap((bg): [string, string, number][] => [
    ["fg", bg, 4.5],
    ["muted", bg, 4.5],
    ["accent", bg, 4.5], // links
    ["danger", bg, 4.5],
    ["success", bg, 3],
    ["warning", bg, 3],
    ["border-strong", bg, 3], // control borders
    ["focus", bg, 3], // focus ring (WCAG 2.4.13 asks 3:1 against adjacent colours)
  ]),
  ["accent-fg", "accent", 4.5], // primary button text
  ["accent-fg", "accent-hover", 4.5],
  ["accent-subtle-fg", "accent-subtle", 4.5], // current navigation item
  ["fg", "accent-subtle", 4.5],
  ["danger", "danger-subtle", 4.5],
  ["focus", "accent-subtle", 3],
];

describe("design tokens", () => {
  it("declares the same tokens in both themes", () => {
    expect(Object.keys(darkMedia).sort()).toEqual(Object.keys(light).sort());
  });

  it("keeps the system-dark and chosen-dark blocks identical", () => {
    expect(darkAttr).toEqual(darkMedia);
  });

  for (const [name, tokens] of [
    ["light", light],
    ["dark", darkMedia],
  ] as const) {
    it.each(PAIRS)(`${name}: %s on %s meets %s:1`, (fg, bg, min) => {
      expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(min);
    });
  }
});
