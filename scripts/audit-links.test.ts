import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import * as linkcheck from './linkcheck.ts';

import {
  DEFAULT_MAX_PAGES,
  DEFAULT_TIME_BUDGET_SECONDS,
  countApiChecks,
  duplicateCoverage,
  duplicateIds,
  main,
  nextBoardPath,
  parseBoundedPositiveInt,
  renderedLinkDiscovery,
  renderedLinks,
} from './audit-links.ts';

it('stops requesting an origin after a refusal without claiming later URLs returned 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workie-audit-test-'));
  const output = join(dir, 'report.json');
  const html = Array.from({ length: 7 }, (_, index) =>
    `<tr><td data-field="apply"><a data-posting-id="${index + 1}" href="https://refused.test/${index + 1}">apply</a></td></tr>`).join('');
  const checked = vi.spyOn(linkcheck, 'checkLink').mockImplementation(async (_runtime, posting) => ({
    ...posting, verdict: 'unverifiable', status: 403, reason: 'HTTP 403',
  }));
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = new URL(String(input));
    const id = url.pathname.match(/^\/api\/postings\/(\d+)$/)?.[1];
    return id ? Response.json({ canonicalUrl: `https://refused.test/${id}` }) : new Response(html);
  });
  try {
    await main(['--base=https://workie.test', '--view=design-employed', `--output=${output}`]);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    expect(checked.mock.calls.length).toBeGreaterThan(0);
    expect(checked.mock.calls.length).toBeLessThan(7);
    expect(report.total).toMatchObject({ apiMatches: 7, blocked: 7 });
    expect(report.views[0].results.some((result: { status: number | null; reason: string }) =>
      result.status === null && result.reason.includes('this URL was not requested'))).toBe(true);
  } finally {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  }
});

function row(jobHref: string, applyHref: string): string {
  return `<tr><td><a href="${jobHref}">Acme</a></td><td><a class="chip" href="${applyHref}">apply</a></td></tr>`;
}

describe('renderedLinks', () => {
  it('finds a streamed Apply anchor outside its original placeholder cell', () => {
    const html = '<tr><td data-field="apply"><template id="P:1"></template></td></tr>'
      + '<div hidden id="S:1"><a data-posting-id="42" class="chip" href="https://example.com/job">apply</a></div>';
    expect(renderedLinkDiscovery(html)).toMatchObject({
      links: [{ id: 42, url: 'https://example.com/job' }],
      expectedApplyCells: 1,
      pairedApplyCells: 1,
      unpairedApplyCells: 0,
    });
  });

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

  it('pairs a streamed Apply cell through its explicit marker regardless of attribute order', () => {
    const html = [
      '<tr><td><a href="/?job=42">Acme</a></td></tr>',
      '<tr id="S:4"><td data-field="apply">',
      '<a href="https://himalayas.app/jobs/42" rel="noreferrer" data-posting-id="42" class="chip">',
      'apply<svg></svg></a></td></tr>',
    ].join('');

    expect(renderedLinkDiscovery(html)).toEqual({
      links: [{ id: 42, url: 'https://himalayas.app/jobs/42' }],
      expectedApplyCells: 1,
      pairedApplyCells: 1,
      unpairedApplyCells: 0,
    });
  });

  it('reports an unmarked streamed Apply cell as unpaired instead of silently dropping it', () => {
    const html = [
      '<tr><td><a href="/?job=42">Acme</a></td></tr>',
      '<tr id="S:4"><td data-field="apply">',
      '<a class="chip" href="https://himalayas.app/jobs/42">apply<svg></svg></a></td></tr>',
    ].join('');

    expect(renderedLinkDiscovery(html)).toEqual({
      links: [],
      expectedApplyCells: 1,
      pairedApplyCells: 0,
      unpairedApplyCells: 1,
    });
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

describe('duplicateIds', () => {
  it('reports duplicate IDs from raw rows without discarding them', () => {
    const links = [
      { id: 7, url: 'https://example.com/one' },
      { id: 8, url: 'https://example.com/two' },
      { id: 7, url: 'https://example.com/three' },
      { id: 8, url: 'https://example.com/two' },
    ];

    expect(duplicateIds(links)).toEqual([7, 8]);
    expect(links).toHaveLength(4);
  });

  it('marks duplicate IDs as incomplete coverage', () => {
    expect(
      duplicateCoverage([
        { id: 7, url: 'https://example.com/one' },
        { id: 7, url: 'https://example.com/two' },
      ]),
    ).toEqual({
      duplicateIdValues: [7],
      partial: true,
      partialReason: 'duplicate posting IDs across rendered pages: 7',
    });
  });
});

describe('countApiChecks', () => {
  it('includes deadline-skipped work in apiNotChecked', () => {
    expect(countApiChecks([{ api: 'match' }, { api: 'not-checked' }, { api: 'unavailable' }])).toEqual({
      apiMatches: 1,
      apiMismatches: 0,
      apiUnavailable: 1,
      apiNotChecked: 1,
    });
  });
});

describe('parseBoundedPositiveInt', () => {
  it('uses the configured default and accepts bounded integers', () => {
    expect(parseBoundedPositiveInt(undefined, 'max-pages', DEFAULT_MAX_PAGES, 100)).toBe(DEFAULT_MAX_PAGES);
    expect(parseBoundedPositiveInt('25', 'max-pages', DEFAULT_MAX_PAGES, 100)).toBe(25);
    expect(
      parseBoundedPositiveInt(undefined, 'time-budget-seconds', DEFAULT_TIME_BUDGET_SECONDS, 10_000),
    ).toBe(DEFAULT_TIME_BUDGET_SECONDS);
  });

  it.each(['', '0', '01', '-1', '1.5', '101', 'abc'])('rejects invalid input %j', (raw) => {
    expect(() => parseBoundedPositiveInt(raw, 'max-pages', DEFAULT_MAX_PAGES, 100)).toThrow(
      `bad --max-pages: ${raw}`,
    );
  });
});
