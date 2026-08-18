/**
 * Pipeline tests. Every one runs against a stub client: no network, no API key, no flake.
 *
 * The stub answers with the HAND-AUTHORED expectations from `classify.fixtures.ts`, so what
 * is asserted here is pipeline behavior — what the pipeline does with a classification —
 * never model quality. Model quality is `npm run enrich:smoke`, which needs a key.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_SPEND_CAP_USD,
  callCostUsd,
  enrichPostings,
  isSeniorByRegex,
  parseSpendCap,
  toStored,
  type Classification,
  type ClassificationCache,
  type ClassifyClient,
  type ClassifyInput,
  type EnrichPosting,
} from './classify';
import { ATS_SHAPES, POSTING_FIXTURES, SENIOR_FIXTURES } from './classify.fixtures';
import { enrichmentCacheKey } from './hash';
import { normalizeDescription } from './normalize';
import { VOICE_BADGE } from './voice';

// ---------------------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------------------

interface Stub {
  client: ClassifyClient;
  calls: ClassifyInput[];
}

/** `tokens` lets a test price a call exactly: 1,000,000 input tokens is $1.00 on Haiku. */
function stubClient(
  answer: (input: ClassifyInput) => unknown,
  tokens: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
): Stub {
  const calls: ClassifyInput[] = [];
  const client: ClassifyClient = async (input) => {
    calls.push(input);
    return { raw: answer(input), ...tokens };
  };
  return { client, calls };
}

const EXPECTED_BY_TITLE = new Map(
  POSTING_FIXTURES.map((fixture) => [fixture.title, fixture.expected]),
);

function fixtureStub(): Stub {
  return stubClient((input) => {
    const expected = EXPECTED_BY_TITLE.get(input.title);
    if (!expected) throw new Error(`no hand-authored label for: ${input.title}`);
    return expected;
  });
}

function refusingClient(): ClassifyClient {
  return async (input) => {
    throw new Error(`the model must not be called for: ${input.title}`);
  };
}

function memoryCache(): ClassificationCache & { size: () => number } {
  const store = new Map<string, Classification>();
  return {
    get: (hash) => store.get(hash) ?? null,
    set: (hash, value) => void store.set(hash, value),
    size: () => store.size,
  };
}

const asPostings = (
  fixtures: readonly { id: number; title: string; company: string; description: string }[],
): EnrichPosting[] =>
  fixtures.map(({ id, title, company, description }) => ({ id, title, company, description }));

// ---------------------------------------------------------------------------------------

describe('regex prefilter (layer 1)', () => {
  it.each(SENIOR_FIXTURES.map((fixture) => [fixture.title, fixture] as const))(
    'drops %s',
    (_title, fixture) => {
      expect(isSeniorByRegex(fixture.title, normalizeDescription(fixture.description))).toBe(true);
    },
  );

  it('covers at least 15 senior postings with zero leaks', async () => {
    expect(SENIOR_FIXTURES.length).toBeGreaterThanOrEqual(15);

    const { results, stats } = await enrichPostings(asPostings(SENIOR_FIXTURES), {
      client: refusingClient(),
      cache: memoryCache(),
    });

    expect(stats.calls).toBe(0);
    expect(stats.costUsd).toBe(0);
    expect(stats.prefilterDrops).toBe(SENIOR_FIXTURES.length);
    expect(results.every((result) => result.classification === null)).toBe(true);
    expect(results.every((result) => result.dropReason === 'prefilter-senior')).toBe(true);
  });

  it('keeps every listed posting — no false positives on the fixture set', () => {
    for (const fixture of POSTING_FIXTURES) {
      expect(
        isSeniorByRegex(fixture.title, normalizeDescription(fixture.description)),
        fixture.title,
      ).toBe(false);
    }
  });

  it('matches years of experience in the body, not just the title', () => {
    expect(isSeniorByRegex('Software Engineer', '5+ years of experience required')).toBe(true);
    expect(isSeniorByRegex('Software Engineer', 'You have 12 years in the industry')).toBe(true);
    expect(isSeniorByRegex('Software Engineer', 'One to two years of experience')).toBe(false);
    expect(isSeniorByRegex('Software Engineer', 'Salary is $120,000 per year')).toBe(false);
  });

  it('reads a range from its start, so the mid band survives', () => {
    // A hyphen is a word boundary, so a regex anchored on the tail of the range reads
    // "2-5 years" as senior and silently drops most mid-level postings.
    expect(isSeniorByRegex('Backend Engineer', 'We want 2-5 years of experience.')).toBe(false);
    expect(isSeniorByRegex('Backend Engineer', 'We want 3 to 5 years of experience.')).toBe(false);
    expect(isSeniorByRegex('Backend Engineer', 'We want 5-7 years of experience.')).toBe(true);
    expect(isSeniorByRegex('Backend Engineer', 'We want 8 to 10 years of experience.')).toBe(true);
  });

  it('sees a senior requirement anywhere in the body, not only the first mention', () => {
    expect(
      isSeniorByRegex('Backend Engineer', '1-2 years with us. Then 9 years of Java for the lead track.'),
    ).toBe(true);
  });

  it('does not fire on a seniority word inside another word', () => {
    expect(isSeniorByRegex('Design Leadership Program Intern', 'A rotational program.')).toBe(false);
  });

  it('lets "Member of Technical Staff" through — it is an IC title, and a voice-AI one', () => {
    expect(isSeniorByRegex('Member of Technical Staff', 'You will tune endpointing.')).toBe(false);
    expect(isSeniorByRegex('Senior Member of Technical Staff', 'Same body.')).toBe(true);
  });

  it('accepts the precision cost of the specified word list', () => {
    // ponytail: "Associate Product Manager" is an entry-level role the `manager` rule drops.
    // It is off-track anyway, so the outcome is right and the call is saved; a title that
    // needs the model to judge it is one the list must not name.
    expect(isSeniorByRegex('Associate Product Manager', 'A rotational new grad program.')).toBe(true);
  });
});

describe('model drops (layer 2)', () => {
  it('drops senior+ that the regex let through', async () => {
    const senior: Classification = { ...POSTING_FIXTURES[6].expected, seniority: 'senior+' };
    const stub = stubClient(() => senior);
    const { results, stats } = await enrichPostings(
      [{ id: 1, title: 'Software Engineer', company: 'Quillon', description: 'You will build things.' }],
      { client: stub.client, cache: memoryCache() },
    );

    expect(stats.calls).toBe(1);
    expect(stats.stored).toBe(0);
    expect(results[0].classification).toBeNull();
    expect(results[0].dropReason).toBe('senior');
  });

  it('drops a track other than design or engineering', async () => {
    const offTrack = POSTING_FIXTURES.filter((fixture) => fixture.expected.track === 'other');
    expect(offTrack.length).toBeGreaterThan(0);

    const { results, stats } = await enrichPostings(asPostings(offTrack), {
      client: fixtureStub().client,
      cache: memoryCache(),
    });

    expect(stats.stored).toBe(0);
    expect(results.every((result) => result.classification === null)).toBe(true);
    expect(results.every((result) => result.dropReason === 'track')).toBe(true);
  });

  it('drops a malformed answer without caching it', async () => {
    const cache = memoryCache();
    const stub = stubClient(() => ({ track: 'engineering' }));
    const posting = { id: 1, title: 'Software Engineer', company: 'Quillon', description: 'Build things.' };

    const first = await enrichPostings([posting], { client: stub.client, cache });
    expect(first.results[0].dropReason).toBe('invalid');
    expect(cache.size()).toBe(0);

    // A bad answer is not preserved as if it were a good one: the next run tries again.
    const second = await enrichPostings([posting], { client: stub.client, cache });
    expect(second.stats.calls).toBe(1);
  });

  it('treats a cache row that no longer matches the schema as a miss', async () => {
    const stale: ClassificationCache = { get: () => ({ track: 'engineering' }), set: () => {} };
    const stub = fixtureStub();
    await enrichPostings(asPostings([POSTING_FIXTURES[0]]), { client: stub.client, cache: stale });
    expect(stub.calls).toHaveLength(1);
  });
});

describe('storing', () => {
  it('stores only design and engineering, with the expected split', async () => {
    const stub = fixtureStub();
    const { results, stats } = await enrichPostings(asPostings(POSTING_FIXTURES), {
      client: stub.client,
      cache: memoryCache(),
    });

    const keepers = POSTING_FIXTURES.filter((fixture) => fixture.expected.track !== 'other');
    expect(stats.processed).toBe(POSTING_FIXTURES.length);
    expect(stats.stored).toBe(keepers.length);
    for (const result of results) {
      if (result.classification === null) continue;
      expect(['design', 'engineering']).toContain(result.classification.track);
      expect(['entry', 'junior', 'mid']).toContain(result.classification.seniority);
    }
  });

  it('badges exactly the voice-AI roles, all of them engineering', async () => {
    const stub = fixtureStub();
    const { results } = await enrichPostings(asPostings(POSTING_FIXTURES), {
      client: stub.client,
      cache: memoryCache(),
    });

    const badged = results.filter((result) => result.classification?.badges.includes(VOICE_BADGE));
    expect(badged.map((result) => result.id)).toEqual(
      POSTING_FIXTURES.filter((fixture) => fixture.voice).map((fixture) => fixture.id),
    );
    for (const result of badged) {
      expect(result.classification?.track).toBe('engineering');
    }
  });

  it('never badges a design posting, whatever its body says', () => {
    const design: Classification = { ...POSTING_FIXTURES[1].expected, track: 'design' };
    const stored = toStored(design, 'We tune endpointing and barge-in all day long.');
    expect(stored?.badges).not.toContain(VOICE_BADGE);
  });

  it('drops the summary for design — the Design tab has no summary column', () => {
    const design: Classification = {
      ...POSTING_FIXTURES[1].expected,
      track: 'design',
      summary: 'Designs onboarding flows.',
    };
    expect(toStored(design, '')?.summary).toBeNull();
    const engineering: Classification = { ...design, track: 'engineering' };
    expect(toStored(engineering, '')?.summary).toBe('Designs onboarding flows.');
  });

  it('discards badges outside the allowed vocabulary', () => {
    const withJunk: Classification = {
      ...POSTING_FIXTURES[0].expected,
      badges: ['internship', 'rockstar', 'fast-paced'],
    };
    expect(toStored(withJunk, '')?.badges).toEqual(['internship']);
  });
});

describe('cache', () => {
  it('makes zero calls and spends $0.00 on a re-run over the same postings', async () => {
    const cache = memoryCache();
    const first = fixtureStub();
    const firstRun = await enrichPostings(asPostings(POSTING_FIXTURES), {
      client: first.client,
      cache,
    });
    expect(firstRun.stats.calls).toBe(POSTING_FIXTURES.length);

    const second = { client: refusingClient() };
    const secondRun = await enrichPostings(asPostings(POSTING_FIXTURES), {
      client: second.client,
      cache,
    });

    expect(secondRun.stats.calls).toBe(0);
    expect(secondRun.stats.costUsd).toBe(0);
    expect(secondRun.stats.cacheHits).toBe(POSTING_FIXTURES.length);
    expect(secondRun.results).toEqual(
      firstRun.results.map((result) => ({ ...result, source: 'cache' })),
    );
  });

  it('collapses the three ATS description shapes and whitespace churn onto one key', async () => {
    const keys = new Set(ATS_SHAPES.map((shape) => enrichmentCacheKey(shape.description)));
    expect(keys.size).toBe(1);

    const cache = memoryCache();
    const stub = stubClient(() => POSTING_FIXTURES[5].expected);
    const { stats } = await enrichPostings(
      ATS_SHAPES.map((shape, index) => ({ id: index + 1, ...shape })),
      { client: stub.client, cache },
    );

    expect(stats.calls).toBe(1);
    expect(stats.cacheHits).toBe(ATS_SHAPES.length - 1);
    expect(cache.size()).toBe(1);
  });

  it('drops a senior posting that shares a cached body with a junior one', async () => {
    // The key is the body alone, so a company that reuses one boilerplate body across levels
    // gets one cache row. The prefilter has to run over cache hits or the senior posting
    // inherits the junior classification and shows up in the tab.
    const body = 'About us: we build logistics software. You will write Go services.';
    const cache = memoryCache();
    const stub = fixtureStub();

    const junior = await enrichPostings(
      [{ id: 1, title: POSTING_FIXTURES[17].title, company: 'Verdant Grid', description: body }],
      { client: stub.client, cache },
    );
    expect(junior.results[0].classification).not.toBeNull();

    const senior = await enrichPostings(
      [{ id: 2, title: 'Senior Software Engineer', company: 'Verdant Grid', description: body }],
      { client: refusingClient(), cache },
    );
    expect(senior.results[0].classification).toBeNull();
    expect(senior.results[0].dropReason).toBe('prefilter-senior');
    expect(senior.results[0].source).toBe('cache');
  });

  it('skips a posting with no description without calling', async () => {
    const stub = stubClient(() => POSTING_FIXTURES[0].expected);
    const { results, stats } = await enrichPostings(
      [{ id: 1, title: 'Software Engineer', company: 'Quillon', description: '   ' }],
      { client: stub.client, cache: memoryCache() },
    );
    expect(stats.calls).toBe(0);
    expect(results[0].dropReason).toBe('empty');
  });
});

describe('spend cap', () => {
  const DOLLAR_A_CALL = { inputTokens: 1_000_000, outputTokens: 0 };

  it('prices a call from token usage', () => {
    expect(callCostUsd(1_000_000, 0)).toBe(1);
    expect(callCostUsd(0, 1_000_000)).toBe(5);
  });

  it('stops at exactly the cap and reports the backlog', async () => {
    const postings: EnrichPosting[] = Array.from({ length: 50 }, (_, index) => ({
      id: index + 1,
      title: 'Junior Frontend Engineer',
      company: `Company ${index}`,
      // Distinct bodies, so nothing hits the cache.
      description: `Build web interfaces for team number ${index}.`,
    }));
    const stub = stubClient(() => POSTING_FIXTURES[14].expected, DOLLAR_A_CALL);

    const { results, stats } = await enrichPostings(postings, {
      client: stub.client,
      cache: memoryCache(),
      spendCapUsd: 5,
    });

    expect(stats.calls).toBe(5);
    expect(stub.calls).toHaveLength(5);
    expect(stats.costUsd).toBe(5);
    expect(stats.processed).toBe(5);
    expect(results).toHaveLength(5);
    expect(stats.capReached).toBe(true);
    expect(stats.remaining).toBe(45);
  });

  it('stops on a client error without losing the work already done', async () => {
    const postings: EnrichPosting[] = [1, 2, 3].map((id) => ({
      id,
      title: 'Junior Frontend Engineer',
      company: `Company ${id}`,
      description: `Build web interfaces for team ${id}.`,
    }));
    let seen = 0;
    const client: ClassifyClient = async () => {
      seen += 1;
      if (seen === 2) throw new Error('529 overloaded');
      return { raw: POSTING_FIXTURES[14].expected, inputTokens: 0, outputTokens: 0 };
    };

    const { results, stats } = await enrichPostings(postings, { client, cache: memoryCache() });

    expect(stats.error).toMatch(/overloaded/);
    expect(stats.remaining).toBe(2);
    expect(results).toHaveLength(1); // the first posting is still classified and written
    expect(stats.stored).toBe(1);
  });

  it('parses the env cap as a trust boundary', () => {
    expect(parseSpendCap(undefined)).toBe(DEFAULT_SPEND_CAP_USD);
    expect(parseSpendCap('')).toBe(DEFAULT_SPEND_CAP_USD);
    expect(parseSpendCap('2.50')).toBe(2.5);
    expect(parseSpendCap('0')).toBe(0);
    expect(() => parseSpendCap('lots')).toThrow(/WORKY_SPEND_CAP_USD/);
    expect(() => parseSpendCap('-1')).toThrow(/WORKY_SPEND_CAP_USD/);
  });
});
