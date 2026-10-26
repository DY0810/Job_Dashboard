/**
 * The contrast gate for Postie's palette, measured rather than eyeballed.
 *
 * It reads `app/globals.css` itself, so editing a token re-runs the measurement: there is no
 * second copy of the palette here to drift out of date. Run `npx vitest run lib/contrast`
 * with `WORKIE_CONTRAST_TABLE=1` to print the table.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('app/globals.css', 'utf8');

function block(selector: string): string {
  const start = CSS.indexOf(selector);
  expect(start, `${selector} missing from globals.css`).toBeGreaterThan(-1);
  const open = CSS.indexOf('{', start);
  return CSS.slice(open + 1, CSS.indexOf('}', open));
}

/** `--name: value;` pairs of a block, with `var(--x)` resolved against :root. */
function declarations(css: string): Record<string, string> {
  return Object.fromEntries([...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));
}
const ROOT = declarations(block(':root {'));
const resolve = (value: string): string => {
  const ref = /^var\(--([\w-]+)\)$/.exec(value);
  return ref ? resolve(ROOT[ref[1]]) : value;
};
const token = (name: string) => resolve(ROOT[name] ?? `missing --${name}`);

function luminance(hex: string): number {
  const m = /^#([\da-f]{3}|[\da-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a hex colour: ${hex}`);
  const full = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(full.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const ratio = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

/** Text token -> a surface it is painted on. Postie's hairline greys are separators, not text, and are not listed. */
const PAIRS: [text: string, surface: string, what: string][] = [
  ['ink', 'white', 'row text, headings'],
  ['ink', 'soft', 'hovered row, buttons'],
  ['ink', 'active', 'current sidebar tab'],
  ['ink', 'unread', 'a posting from the last 24 hours'],
  ['muted', 'white', 'secondary cells, notes'],
  ['muted', 'soft', 'hovered row, neutral pills and tab counts (Postie\'s --hover fill is 4.44:1, so pills sit on --soft)'],
  ['muted', 'head', 'column heads'],
  ['muted', 'side-bg', 'sidebar progress note'],
  ['accent', 'white', 'apply links'],
  ['accent', 'unread', 'apply link on a fresh row'],
  ['primary-ink', 'primary', 'lime primary button'],
  ['white', 'ink', 'a chosen filter pill'],
  ['danger', 'white', 'errors'],
  ['white', 'danger', 'inbox count'],
  ['work', 'work-bg', 'ready stat'],
  ['tips', 'tips-bg', 'posted stat'],
];

const TONES = [...CSS.matchAll(/\.badge\[data-tone="(\w+)"\] \{ --tone: (#[\da-f]+); --tone-bg: (#[\da-f]+); \}/gi)]
  .map(([, tone, fg, bg]) => [tone, fg, bg] as const);

describe('contrast', () => {
  it.each(PAIRS)('%s on %s passes WCAG AA', (text, surface, what) => {
    const measured = ratio(token(text), token(surface));
    expect(Number(measured.toFixed(2)), `${text} on ${surface} (${what}) is ${measured.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
  });

  it('every status pill label passes WCAG AA on its own fill', () => {
    expect(TONES.length).toBeGreaterThan(9);
    for (const [tone, fg, bg] of TONES) {
      expect(Number(ratio(fg, bg).toFixed(2)), tone).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('prints the measured table', () => {
    if (!process.env.WORKIE_CONTRAST_TABLE) return;
    for (const [text, surface, what] of PAIRS) console.log(`${text} on ${surface}`.padEnd(28), ratio(token(text), token(surface)).toFixed(2), what);
    for (const [tone, fg, bg] of TONES) console.log(`badge ${tone}`.padEnd(28), ratio(fg, bg).toFixed(2));
  });
});

describe('theme structure', () => {
  // Postie is light only; half a dark theme would leave pages unreadable when the OS is dark.
  it('defines no dark palette', () => {
    expect(CSS).not.toMatch(/prefers-color-scheme:\s*dark|data-theme/);
  });
});
