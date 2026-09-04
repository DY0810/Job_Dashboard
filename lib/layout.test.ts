/**
 * The one layout contract that cannot be eyeballed, because when it breaks the evidence is
 * 500,000 pixels off the right edge of the screen.
 *
 * `.rows td.grow` is the flexible-and-truncating column trick: `width: 100%` makes it absorb
 * whatever the fixed columns leave, and `max-width: 0` + `overflow: hidden` makes it ellipsize
 * instead of pushing them out. It only works while the TABLE has a definite width to take a
 * percentage of.
 *
 * `w-max` on an ancestor (`width: max-content`) removes that definite width. The percentage
 * then resolves against an indefinite container, the browser clamps the circular result at
 * some enormous number, and every column after `title` — pay rate, company, and APPLY — lands
 * hundreds of thousands of pixels off-screen where no scrollbar reaches them. The page still
 * renders, the HTML still contains every cell, and the test suite still passes, which is
 * exactly why this is a test and not a comment: it shipped once and survived a day unnoticed.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const CSS = readFileSync('app/globals.css', 'utf8');
const PAGE = readFileSync('app/page.tsx', 'utf8');

describe('the flexible column contract', () => {
  it('still depends on a definite width, or this whole file is moot', () => {
    // The premise. If someone rewrites `.grow` to not use a percentage — `table-layout: fixed`,
    // say — this guard is obsolete rather than merely passing, and should be deleted.
    const grow = /\.rows td\.grow,\s*\n\s*\.rows th\.grow \{([^}]*)\}/.exec(CSS)?.[1] ?? '';
    expect(grow).toContain('width: 100%');
    expect(grow).toContain('max-width: 0');
    expect(CSS).toMatch(/\.rows \{[^}]*width: 100%/);
  });

  it('is never nested inside a max-content ancestor', () => {
    for (const main of PAGE.match(/<main className="[^"]*"/g) ?? []) {
      expect(main, 'w-max here pushes company and apply ~500,000px off-screen').not.toMatch(
        /\bw-max\b|\bw-min\b|\bw-fit\b/,
      );
    }
  });

  it('checked every <main> on the page, not just the first', () => {
    // Both the configured board and the not-configured fallback render one, and the bug was
    // introduced into both at once by a single find-and-replace.
    expect((PAGE.match(/<main className="/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
