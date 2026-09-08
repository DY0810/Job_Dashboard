import { describe, expect, it } from 'vitest';

import { nextBoardPath, renderedLinks } from './audit-links.ts';

function row(jobHref: string, applyHref: string): string {
  return `<tr><td><a href="${jobHref}">Acme</a></td><td><a class="chip" href="${applyHref}">apply</a></td></tr>`;
}

describe('renderedLinks', () => {
  it('extracts the default and non-default board query shapes', () => {
    const links = renderedLinks(
      [
        row('/?job=42', 'https://example.com/default'),
        row('/?basis=freelance&amp;job=43', 'https://example.com/freelance?x=1&amp;y=2'),
        row('/?tab=engineering&amp;job=44', 'https://example.com/engineering'),
      ].join(''),
    );

    expect(links).toEqual([
      { id: 42, url: 'https://example.com/default' },
      { id: 43, url: 'https://example.com/freelance?x=1&y=2' },
      { id: 44, url: 'https://example.com/engineering' },
    ]);
  });
});

describe('nextBoardPath', () => {
  const base = new URL('https://workie.test');

  it('follows rel=next and visible Next links on the same origin', () => {
    expect(nextBoardPath('<a rel="next" href="/?page=2">older</a>', base, base)).toBe('/?page=2');
    expect(nextBoardPath('<a href="/?tab=engineering&amp;page=2">Next</a>', base, base)).toBe(
      '/?tab=engineering&page=2',
    );
  });

  it('does not follow a cross-origin next link', () => {
    expect(nextBoardPath('<a rel="next" href="https://other.test/?page=2">next</a>', base, base)).toBeNull();
  });
});
