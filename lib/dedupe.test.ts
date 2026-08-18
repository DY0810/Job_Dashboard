import { describe, expect, it } from 'vitest';

import {
  cutoffTimestamp,
  dedupeKey,
  dedupePostings,
  isGhost,
  isWithinCutoff,
  locationKey,
  nextAbsenceCount,
  POSTING_MAX_AGE_DAYS,
  SOURCE_PRIORITY,
  tokenSetRatio,
  type RawPosting,
} from './dedupe.ts';
import { normalizeLocation } from './normalize.ts';

const at = (iso: string) => Date.parse(iso);

const posting = (over: Partial<RawPosting> = {}): RawPosting => ({
  source: 'greenhouse',
  sourceKind: 'ats',
  sourceUrl: 'https://boards.greenhouse.io/figma/jobs/4567890',
  postedAt: at('2026-07-28T20:04:00Z'),
  company: 'Figma',
  title: 'Product Designer',
  location: 'San Francisco, CA',
  ...over,
});

describe('locationKey', () => {
  it('pins one string per location shape', () => {
    expect(locationKey(normalizeLocation('San Francisco, CA'))).toBe('onsite|sf|CA|US');
    expect(locationKey(normalizeLocation('Berlin, Germany'))).toBe('onsite|berlin||DE');
    expect(locationKey(normalizeLocation('Remote'))).toBe('remote');
    expect(locationKey(normalizeLocation('Remote, USA'))).toBe('remote');
    expect(locationKey(normalizeLocation(null))).toBe('unknown');
  });

  it('keeps remote and unknown distinct', () => {
    expect(locationKey(normalizeLocation('Remote'))).not.toBe(locationKey(normalizeLocation('')));
  });
});

describe('dedupeKey', () => {
  it('is a sha256 hex digest of the normalized triple', () => {
    expect(dedupeKey('Figma', 'Product Designer', 'San Francisco, CA')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('collapses source spelling differences', () => {
    const key = dedupeKey('Figma', 'Product Designer', 'San Francisco, CA');
    expect(dedupeKey('Figma, Inc.', 'Product Designer (Remote Friendly)', 'Palo Alto')).toBe(key);
    expect(dedupeKey('  FIGMA  ', 'Product Designer [REQ-1042]', 'SF')).toBe(key);
  });

  /**
   * The decisive one. An ATS says "New York, NY" and an aggregator says "New York City, New
   * York, United States"; `city_norm` is a key component, so if the alias table misses the
   * longer spelling the same job stays two postings and "zero cross-source duplicates" is
   * quietly untrue. 137 rows in the live corpus carry one of these spellings.
   */
  it('collapses the spellings of one metro that different sources send', () => {
    const nyc = dedupeKey('Figma', 'Product Designer', 'New York, NY');
    for (const spelling of [
      'New York City, New York, United States',
      'New York HQ',
      'New York Office',
      'NYC',
    ]) {
      expect(dedupeKey('Figma', 'Product Designer', spelling), spelling).toBe(nyc);
    }

    const sf = dedupeKey('Figma', 'Product Designer', 'San Francisco, CA');
    expect(dedupeKey('Figma', 'Product Designer', 'San Francisco Office')).toBe(sf);

    // And does not over-collapse: a town whose name starts with a metro's is its own place.
    expect(dedupeKey('Figma', 'Product Designer', 'New York Mills, MN')).not.toBe(nyc);
  });

  it('separates the same role in different places', () => {
    const sf = dedupeKey('Figma', 'Product Designer', 'San Francisco, CA');
    expect(dedupeKey('Figma', 'Product Designer', 'New York, NY')).not.toBe(sf);
    expect(dedupeKey('Figma', 'Product Designer', 'Remote')).not.toBe(sf);
    expect(dedupeKey('Figma', 'Product Designer', null)).not.toBe(sf);
    expect(dedupeKey('Figma', 'Product Designer', 'Remote')).not.toBe(
      dedupeKey('Figma', 'Product Designer', null),
    );
  });
});

// FINDING E — the ratio is pinned, and these are the expected values, not observed ones.
describe('tokenSetRatio', () => {
  it.each([
    ['product designer', 'product designer', 1],
    ['software engineer backend', 'backend software engineer', 1],
    ['designer designer', 'designer', 1],
    ['product designer', 'product designer ii', 0.8],
    ['senior product designer', 'product designer', 0.8],
    ['product designer', 'backend engineer', 0],
    ['', '', 0],
    ['product designer', '', 0],
  ])('tokenSetRatio(%j, %j) === %s', (a, b, expected) => {
    expect(tokenSetRatio(a, b)).toBe(expected);
  });

  it('is symmetric', () => {
    expect(tokenSetRatio('product designer ii', 'product designer')).toBe(0.8);
  });

  it('sits between the two thresholds when one token of six differs', () => {
    // 2 * 5 / (5 + 6) = 0.909… — over the 0.90 near-dupe bar, under the 0.95 remote bar.
    expect(tokenSetRatio('product designer design systems tooling', 'product designer design systems tooling emea')).toBeCloseTo(
      10 / 11,
      10,
    );
  });
});

describe('source priority and canonical_url', () => {
  it('prefers the ATS URL whenever any source is an ATS', () => {
    const [merged] = dedupePostings([
      posting({ source: 'weworkremotely', sourceKind: 'rss', sourceUrl: 'https://wwr/1' }),
      posting({ source: 'remotive', sourceKind: 'aggregator', sourceUrl: 'https://remotive/1' }),
      posting({ source: 'greenhouse', sourceKind: 'ats', sourceUrl: 'https://gh/1' }),
    ]);
    expect(merged.canonicalUrl).toBe('https://gh/1');
    expect(merged.sources).toHaveLength(3);
  });

  it('falls back to the highest-priority URL when no source is an ATS', () => {
    const [merged] = dedupePostings([
      posting({ source: 'simplify', sourceKind: 'repo', sourceUrl: 'https://repo/1' }),
      posting({ source: 'weworkremotely', sourceKind: 'rss', sourceUrl: 'https://wwr/1' }),
      posting({ source: 'remotive', sourceKind: 'aggregator', sourceUrl: 'https://remotive/1' }),
    ]);
    expect(merged.canonicalUrl).toBe('https://remotive/1');
    expect(merged.sources.map((s) => s.sourcePriority)).toEqual([
      SOURCE_PRIORITY.aggregator,
      SOURCE_PRIORITY.rss,
      SOURCE_PRIORITY.repo,
    ]);
  });

  it('breaks a tie between two ATS sources on the earlier posted_at', () => {
    const [merged] = dedupePostings([
      posting({ source: 'lever', sourceUrl: 'https://lever/1', postedAt: at('2026-07-30T00:00:00Z') }),
      posting({ source: 'greenhouse', sourceUrl: 'https://gh/1', postedAt: at('2026-07-28T00:00:00Z') }),
    ]);
    expect(merged.canonicalUrl).toBe('https://gh/1');
  });

  it('never discards a source, and keeps each source posted_at', () => {
    const [merged] = dedupePostings([
      posting({ source: 'greenhouse', sourceUrl: 'https://gh/1', postedAt: at('2026-07-28T00:00:00Z') }),
      posting({
        source: 'remotive',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remotive/1',
        postedAt: at('2026-07-30T00:00:00Z'),
      }),
    ]);
    expect(merged.sources).toHaveLength(2);
    expect(merged.sources.find((s) => s.source === 'remotive')?.postedAt).toBe(
      at('2026-07-30T00:00:00Z'),
    );
  });

  it('collapses a repeated source URL into one source row', () => {
    const [merged] = dedupePostings([
      posting({ sourceUrl: 'https://gh/1', postedAt: at('2026-07-30T00:00:00Z') }),
      posting({ sourceUrl: 'https://gh/1', postedAt: at('2026-07-28T00:00:00Z') }),
    ]);
    expect(merged.sources).toHaveLength(1);
    expect(merged.sources[0].postedAt).toBe(at('2026-07-28T00:00:00Z'));
  });
});

// FINDING D — a lying aggregator must not age a live posting out of the 60-day window.
describe('posted_at merge', () => {
  it('takes the MIN across sources when no ATS source exists', () => {
    const [merged] = dedupePostings([
      posting({ source: 'remotive', sourceKind: 'aggregator', sourceUrl: 'https://remotive/1', postedAt: at('2026-07-28T00:00:00Z') }),
      posting({ source: 'remoteok', sourceKind: 'aggregator', sourceUrl: 'https://remoteok/1', postedAt: at('2026-06-01T00:00:00Z') }),
    ]);
    expect(merged.postedAt).toBe(at('2026-06-01T00:00:00Z'));
  });

  it('floors the MIN at the ATS date when an ATS source exists', () => {
    const [merged] = dedupePostings([
      posting({ source: 'greenhouse', sourceUrl: 'https://gh/1', postedAt: at('2026-07-28T00:00:00Z') }),
      posting({
        source: 'remoteok',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remoteok/1',
        postedAt: at('2026-06-01T00:00:00Z'),
      }),
    ]);
    expect(merged.postedAt).toBe(at('2026-07-28T00:00:00Z'));
    // The lying source keeps its own date on its own row.
    expect(merged.sources.find((s) => s.source === 'remoteok')?.postedAt).toBe(
      at('2026-06-01T00:00:00Z'),
    );
  });

  it('falls back rather than dating an undateable posting to 1970', () => {
    const now = at('2026-08-17T00:00:00Z');
    const [merged] = dedupePostings([posting({ postedAt: Number.NaN })], {
      fallbackPostedAt: now,
    });
    expect(merged.postedAt).toBe(now);
    expect(isWithinCutoff(merged.postedAt, now)).toBe(true);
  });

  it('ignores an unparseable date when another source has a good one', () => {
    const [merged] = dedupePostings([
      posting({ source: 'weworkremotely', sourceKind: 'rss', sourceUrl: 'https://wwr/1', postedAt: Number.NaN }),
      posting({ sourceUrl: 'https://gh/1', postedAt: at('2026-07-28T00:00:00Z') }),
    ]);
    expect(merged.postedAt).toBe(at('2026-07-28T00:00:00Z'));
  });

  it('still takes the earlier date when the aggregator is not lying', () => {
    const [merged] = dedupePostings([
      posting({ source: 'greenhouse', sourceUrl: 'https://gh/1', postedAt: at('2026-07-28T00:00:00Z') }),
      posting({
        source: 'remoteok',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remoteok/1',
        postedAt: at('2026-07-30T00:00:00Z'),
      }),
    ]);
    expect(merged.postedAt).toBe(at('2026-07-28T00:00:00Z'));
  });
});

describe('near-dupe pass (same company + location, title ratio >= 0.90)', () => {
  // GATE boundary case 1 — 0.80, on the do-not-merge side of 0.90.
  it('does not merge Product Designer with Product Designer II', () => {
    const merged = dedupePostings([
      posting({ title: 'Product Designer', sourceUrl: 'https://gh/1' }),
      posting({ title: 'Product Designer II', sourceUrl: 'https://gh/2' }),
    ]);
    expect(tokenSetRatio('product designer', 'product designer ii')).toBe(0.8);
    expect(merged).toHaveLength(2);
  });

  // GATE boundary case 2 — 1.00, on the merge side of 0.90.
  it('merges Software Engineer, Backend with Backend Software Engineer', () => {
    const merged = dedupePostings([
      posting({ title: 'Software Engineer, Backend', sourceUrl: 'https://gh/1' }),
      posting({
        title: 'Backend Software Engineer',
        source: 'arbeitnow',
        sourceKind: 'aggregator',
        sourceUrl: 'https://arbeitnow/1',
      }),
    ]);
    expect(tokenSetRatio('software engineer backend', 'backend software engineer')).toBe(1);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toHaveLength(2);
    expect(merged[0].canonicalUrl).toBe('https://gh/1');
  });

  it('merges at 0.909, above the 0.90 bar', () => {
    const merged = dedupePostings([
      posting({ title: 'Product Designer Design Systems Tooling', sourceUrl: 'https://gh/1' }),
      posting({
        title: 'Product Designer Design Systems Tooling EMEA',
        source: 'remotive',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remotive/1',
      }),
    ]);
    expect(merged).toHaveLength(1);
  });

  it('merges a work-mode-prefixed location on the exact key', () => {
    const merged = dedupePostings([
      posting({ location: 'San Francisco, CA', sourceUrl: 'https://gh/1' }),
      posting({
        location: 'Hybrid - San Francisco, CA',
        source: 'arbeitnow',
        sourceKind: 'aggregator',
        sourceUrl: 'https://arbeitnow/1',
      }),
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0].locationKey).toBe('onsite|sf|CA|US');
  });

  it('never merges across locations — same role in two cities is two jobs', () => {
    const merged = dedupePostings([
      posting({ location: 'San Francisco, CA', sourceUrl: 'https://gh/1' }),
      posting({ location: 'New York, NY', sourceUrl: 'https://gh/2' }),
    ]);
    expect(merged).toHaveLength(2);
  });
});

// FINDING I — the remote-vs-city hole. Third pass: same company, ratio >= 0.95,
// exactly one side remote. The ATS source's location is kept as truth.
describe('remote-vs-city merge pass', () => {
  const greenhouseSf = posting({ sourceUrl: 'https://gh/1', location: 'San Francisco, CA' });
  const remoteOkRemote = posting({
    source: 'remoteok',
    sourceKind: 'aggregator',
    sourceUrl: 'https://remoteok/1',
    location: 'Remote',
    postedAt: at('2026-07-29T00:00:00Z'),
  });

  it('merges the city posting into the remote one (ATS first)', () => {
    const merged = dedupePostings([greenhouseSf, remoteOkRemote]);
    expect(merged).toHaveLength(1);
    expect(merged[0].sources).toHaveLength(2);
    expect(merged[0].canonicalUrl).toBe('https://gh/1');
    expect(merged[0].location.city_norm).toBe('sf');
    expect(merged[0].location.is_remote).toBe(false);
    expect(merged[0].locationKey).toBe('onsite|sf|CA|US');
  });

  it('merges in the other direction too (remote first)', () => {
    const merged = dedupePostings([remoteOkRemote, greenhouseSf]);
    expect(merged).toHaveLength(1);
    expect(merged[0].location.city_norm).toBe('sf');
    expect(merged[0].canonicalUrl).toBe('https://gh/1');
    expect(merged[0].dedupeKey).toBe(dedupePostings([greenhouseSf, remoteOkRemote])[0].dedupeKey);
  });

  it('does NOT merge two genuinely different remote roles at the same company', () => {
    const merged = dedupePostings([
      posting({ title: 'Product Designer', location: 'San Francisco, CA', sourceUrl: 'https://gh/1' }),
      posting({
        title: 'Backend Software Engineer',
        location: 'Remote',
        source: 'remoteok',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remoteok/1',
      }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('does NOT merge when neither side is remote', () => {
    const merged = dedupePostings([
      posting({ title: 'Product Designer', location: 'San Francisco, CA', sourceUrl: 'https://gh/1' }),
      posting({ title: 'Product Designer', location: 'New York, NY', sourceUrl: 'https://gh/2' }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('holds the tighter 0.95 bar — a 0.909 title pair does not merge across remote', () => {
    const merged = dedupePostings([
      posting({ title: 'Product Designer Design Systems Tooling', sourceUrl: 'https://gh/1' }),
      posting({
        title: 'Product Designer Design Systems Tooling EMEA',
        location: 'Remote',
        source: 'remotive',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remotive/1',
      }),
    ]);
    expect(merged).toHaveLength(2);
  });

  it('keeps the higher-priority location when no ATS source is involved', () => {
    const [merged] = dedupePostings([
      posting({
        source: 'remoteok',
        sourceKind: 'aggregator',
        sourceUrl: 'https://remoteok/1',
        location: 'Remote',
      }),
      posting({
        source: 'weworkremotely',
        sourceKind: 'rss',
        sourceUrl: 'https://wwr/1',
        location: 'San Francisco, CA',
      }),
    ]);
    expect(merged.location.is_remote).toBe(true);
  });
});

// FINDING C — an absence only counts when that source's connector run succeeded.
describe('ghost detection', () => {
  it('counts an absence only on a successful poll', () => {
    expect(nextAbsenceCount(0, { seen: false, runStatus: 'ok' })).toBe(1);
    expect(nextAbsenceCount(1, { seen: false, runStatus: 'ok' })).toBe(2);
  });

  it('resets on reappearance', () => {
    expect(nextAbsenceCount(2, { seen: true, runStatus: 'ok' })).toBe(0);
  });

  it('does not count an absence when the connector run errored', () => {
    expect(nextAbsenceCount(1, { seen: false, runStatus: 'error' })).toBe(1);
    expect(nextAbsenceCount(0, { seen: false, runStatus: 'error' })).toBe(0);
  });

  it('delists after two consecutive absences from every source', () => {
    let count = 0;
    count = nextAbsenceCount(count, { seen: false, runStatus: 'ok' });
    expect(isGhost([{ absenceCount: count }])).toBe(false);
    count = nextAbsenceCount(count, { seen: false, runStatus: 'ok' });
    expect(isGhost([{ absenceCount: count }])).toBe(true);
  });

  it('NEGATIVE: a source that errors on both polls delists nothing', () => {
    let count = 0;
    for (let poll = 0; poll < 2; poll += 1) {
      count = nextAbsenceCount(count, { seen: false, runStatus: 'error' });
    }
    expect(count).toBe(0);
    expect(isGhost([{ absenceCount: count }])).toBe(false);
  });

  it('stays live while any source still lists it', () => {
    expect(isGhost([{ absenceCount: 2 }, { absenceCount: 0 }])).toBe(false);
    expect(isGhost([{ absenceCount: 2 }, { absenceCount: 3 }])).toBe(true);
    expect(isGhost([])).toBe(false);
  });
});

describe('60-day cutoff', () => {
  const now = at('2026-08-17T00:00:00Z');
  const daysAgo = (n: number) => now - n * 24 * 60 * 60 * 1000;

  it('is a filter boundary, inclusive at exactly 60 days', () => {
    expect(POSTING_MAX_AGE_DAYS).toBe(60);
    expect(isWithinCutoff(daysAgo(59), now)).toBe(true);
    expect(isWithinCutoff(daysAgo(60), now)).toBe(true);
    expect(isWithinCutoff(daysAgo(61), now)).toBe(false);
    expect(cutoffTimestamp(now)).toBe(daysAgo(60));
  });

  it('does not remove old postings from a dedupe run — the cutoff is query-level only', () => {
    const merged = dedupePostings([posting({ postedAt: daysAgo(400) })]);
    expect(merged).toHaveLength(1);
    expect(isWithinCutoff(merged[0].postedAt, now)).toBe(false);
  });
});
