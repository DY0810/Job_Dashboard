/**
 * The contrast and theme-structure gate, measured rather than eyeballed.
 *
 * It reads `app/globals.css` itself, so editing a token re-runs the measurement: there is no
 * second copy of the palette here to drift out of date. Run `npx vitest run lib/contrast`
 * with `WORKIE_CONTRAST_TABLE=1` to print the table.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('app/globals.css', 'utf8');

// ── colour maths ──────────────────────────────────────────────────────────────────────
// OKLCH -> Oklab -> linear sRGB -> gamma-encoded sRGB (clamped, because a token may sit
// outside the display gamut) -> WCAG relative luminance.

function oklchToSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;

  const linear = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];

  return linear.map((v) => {
    const encoded = v <= 0.0031308 ? 12.92 * v : 1.055 * Math.abs(v) ** (1 / 2.4) - 0.055;
    return Math.min(1, Math.max(0, encoded));
  }) as [number, number, number];
}

function luminance(srgb: [number, number, number]): number {
  const [r, g, b] = srgb.map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(fg: string, bg: string): number {
  const a = luminance(oklchToSrgb(...parse(fg)));
  const b = luminance(oklchToSrgb(...parse(bg)));
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

function parse(value: string): [number, number, number] {
  const m = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(value.trim());
  if (!m) throw new Error(`not an oklch() value: ${value}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ── the palette, read out of the stylesheet ───────────────────────────────────────────

function block(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} missing from globals.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

function declarations(css: string): Record<string, string> {
  return Object.fromEntries(
    [...css.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map(([, k, v]) => [k, v.trim()]),
  );
}

const root = declarations(block(':root {'));
const themes = {
  light: Object.fromEntries(
    Object.entries(root)
      .filter(([k]) => k.startsWith('--light-'))
      .map(([k, v]) => [k.replace('--light-', ''), v]),
  ),
  dark: Object.fromEntries(
    Object.entries(root)
      .filter(([k]) => k.startsWith('--dark-'))
      .map(([k, v]) => [k.replace('--dark-', ''), v]),
  ),
};

/** Text token -> the surfaces it is ever painted on, and the threshold each must clear. */
const PAIRS: [text: string, surface: string, min: number, what: string][] = [
  ['fg', 'canvas', 4.5, 'row text, headings, apply links'],
  ['fg', 'surface', 4.5, 'active chip label'],
  ['fg-dim', 'canvas', 4.5, 'column heads, secondary cells, drawer prose'],
  ['fg-dim', 'surface', 4.5, 'chip label'],
  ['accent', 'canvas', 4.5, 'the last-24-hours band label'],
  ['accent', 'surface', 3, 'band rule against an adjacent chip'],
  // Not text: this token draws the 1px border that makes a chip read as pressable, so WCAG
  // 1.4.11 (non-text contrast, 3:1) applies rather than 4.5:1. It sat at 1.25:1 on canvas —
  // the control was invisible until it was already active.
  ['fg-faint', 'canvas', 3, 'the 1px border that makes a chip read as a control'],
  ['fg-faint', 'surface', 3, 'the same border on an active chip'],
];

describe('contrast', () => {
  it.each(['light', 'dark'] as const)('%s theme: every text token passes WCAG AA', (theme) => {
    const palette = themes[theme];
    expect(Object.keys(palette).length).toBeGreaterThan(4);
    for (const [text, surface, min] of PAIRS) {
      const measured = ratio(palette[text], palette[surface]);
      expect(
        Number(measured.toFixed(2)),
        `${theme}: ${text} on ${surface} is ${measured.toFixed(2)}:1, needs ${min}:1`,
      ).toBeGreaterThanOrEqual(min);
    }
  });

  it('disabled text stays perceivable while reading as unavailable', () => {
    // `fg-faint` paints disabled controls and the aria-hidden loading skeleton, and nothing
    // else — every token that carries content is in PAIRS above and clears AA. WCAG 1.4.3
    // exempts disabled controls, so this is a floor: clearly dimmer than fg-dim, not invisible.
    for (const theme of ['light', 'dark'] as const) {
      const p = themes[theme];
      const faint = ratio(p['fg-faint'], p.canvas);
      expect(faint, `${theme} fg-faint`).toBeGreaterThan(2);
      expect(faint, `${theme} fg-faint`).toBeLessThan(ratio(p['fg-dim'], p.canvas));
    }
  });

  it('prints the measured table', () => {
    const lines = ['| pair | light | dark | min |', '| --- | --- | --- | --- |'];
    for (const [text, surface, min, what] of PAIRS) {
      lines.push(
        `| ${text} on ${surface} — ${what} | ${ratio(themes.light[text], themes.light[surface]).toFixed(2)}:1 ` +
          `| ${ratio(themes.dark[text], themes.dark[surface]).toFixed(2)}:1 | ${min}:1 |`,
      );
    }
    for (const informational of [
      ['fg-faint', 'canvas', 'disabled text (WCAG-exempt)'],
      ['rule', 'canvas', 'hairline separator (decorative)'],
    ] as const) {
      const [a, b, what] = informational;
      lines.push(
        `| ${a} on ${b} — ${what} | ${ratio(themes.light[a], themes.light[b]).toFixed(2)}:1 ` +
          `| ${ratio(themes.dark[a], themes.dark[b]).toFixed(2)}:1 | n/a |`,
      );
    }
    if (process.env.WORKIE_CONTRAST_TABLE) console.log(lines.join('\n'));
    expect(lines.length).toBe(PAIRS.length + 4);
  });
});

describe('theme structure', () => {
  const active = Object.keys(root).filter((k) => !k.startsWith('--light-') && !k.startsWith('--dark-'));
  const media = declarations(block(':root:not([data-theme="light"]) {'));
  const forced = declarations(block(':root[data-theme="dark"] {'));

  it('no token gets its only definition inside a media query', () => {
    expect(active.length).toBeGreaterThan(4);
    for (const token of Object.keys(media)) {
      if (token === 'color-scheme') continue;
      expect(active, `${token} is only defined in the dark media query`).toContain(token);
    }
  });

  it('the media query and the forced override assign the same values', () => {
    expect(forced).toEqual(media);
  });

  it('the dark blocks re-point tokens rather than restating colours', () => {
    for (const [token, value] of Object.entries(media)) {
      if (token === 'color-scheme') continue;
      expect(value, `${token} should reference the dark palette, not inline a colour`).toMatch(
        /^var\(--dark-[\w-]+\)$/,
      );
    }
  });

  it('both palettes define exactly the same token names', () => {
    expect(Object.keys(themes.light).sort()).toEqual(Object.keys(themes.dark).sort());
  });

  it('never uses pure black or pure white', () => {
    expect(CSS).not.toMatch(/#fff\b|#ffffff\b|#000\b|#000000\b/i);
    expect(CSS).not.toMatch(/\b(?:white|black)\b\s*;/);
  });
});
