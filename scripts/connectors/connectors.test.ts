/**
 * One integration test per connector, against a RECORDED FIXTURE. The whole suite runs with
 * the network unplugged; the fixtures were recorded from a live run with
 * `npm run ingest -- --dry-run --record --only=<name>`.
 */

import { describe, expect, it } from 'vitest';

import { normalizeCompany, normalizeTitle } from '../../lib/normalize.ts';
import type { Connector, ConnectorContext, ConnectorPosting, Runtime } from '../../lib/runtime.ts';

import { ashby, greenhouse, lever, recruitee, smartrecruiters, workable } from './ats.ts';
import { arbeitnow, hn, remoteok, remotive, workingnomads } from './agg.ts';
import { fixtureRuntime, loadFixture, recordingRuntime, type Fixture } from './fixtures.ts';
import { adzuna, careerjet, jooble, usajobs } from './keyed.ts';
import { parseReadmeTable, simplifyInternships } from './repo.ts';
import { jobspresso, weworkremotely } from './rss.ts';

/** A runtime that answers every request with one canned body. */
function stubRuntime(body: string): Runtime {
  return {
    fetchText: async () => body,
    fetchJson: async <T,>(): Promise<T> => JSON.parse(body) as T,
    isAllowed: async () => true,
  };
}

function replay(name: string): {
  context: ConnectorContext;
  logs: Record<string, unknown>[];
  degraded: string[];
} {
  const logs: Record<string, unknown>[] = [];
  const degraded: string[] = [];
  return {
    logs,
    degraded,
    context: {
      runtime: fixtureRuntime(loadFixture(name)),
      env: {},
      log: (record) => logs.push(record),
      degraded: (reason) => degraded.push(reason),
    },
  };
}

/** Every connector's output must survive the same trip into `lib/dedupe.ts`. */
function expectCanonicalShape(posting: ConnectorPosting, expected: Connector): void {
  expect(posting.source).toBe(expected.name);
  expect(posting.sourceKind).toBe(expected.kind);
  expect(posting.sourceUrl).toMatch(/^https?:\/\//);
  expect(Number.isFinite(posting.postedAt)).toBe(true);
  // posted_at has to be a plausible date, not a stray sentinel that ages the row out.
  expect(posting.postedAt).toBeGreaterThan(Date.parse('2015-01-01'));
  expect(posting.postedAt).toBeLessThan(Date.now() + 7 * 86_400_000);
  expect(normalizeCompany(posting.company).length).toBeGreaterThan(0);
  expect(normalizeTitle(posting.title).length).toBeGreaterThan(0);
}

/**
 * `simplify-internships` is the one exception to "non-empty description": the SimplifyJobs
 * README table has no job body to read — only company, role, location and an apply link.
 * Padding it out with its own cells restated as prose would be inventing a description; the
 * field stays empty and fills in from a higher-priority source when the job merges.
 */
const NO_DESCRIPTION_AVAILABLE = new Set(['simplify-internships']);

const RECORDED: Connector[] = [
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workable,
  recruitee,
  hn,
  remoteok,
  arbeitnow,
  workingnomads,
  weworkremotely,
  jobspresso,
  simplifyInternships,
];

describe.each(RECORDED.map((connector) => [connector.name, connector] as const))(
  '%s (recorded fixture)',
  (name, connector) => {
    it('returns at least one posting in the canonical shape', async () => {
      const { context } = replay(name);
      const results = await connector.fetch(context);

      expect(results.length).toBeGreaterThan(0);
      for (const posting of results) expectCanonicalShape(posting, connector);

      if (!NO_DESCRIPTION_AVAILABLE.has(name)) {
        expect(results.some((posting) => posting.description.length > 0)).toBe(true);
      }
    });

    it('yields descriptions with no HTML tags or entities left in them', async () => {
      const { context } = replay(name);
      for (const posting of await connector.fetch(context)) {
        expect(posting.description).not.toMatch(/<\/?[a-z][^<>]*>/i);
        expect(posting.description).not.toMatch(/&(amp|lt|gt|quot|#\d+);/);
      }
    });
  },
);

describe('ATS per-target isolation (Phase 3 gate)', () => {
  it('a target that fails logs ONE failure and does not abort the connector', async () => {
    // Only the first boards are recorded, so every other registry token behaves exactly like
    // a dead one: the connector logs each and still returns the boards that answered.
    const { context, logs } = replay('greenhouse');
    const results = await greenhouse.fetch(context);

    const failures = logs.filter((line) => line.status === 'error');
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.connector).toBe('greenhouse');
      expect(failure.company).toBeTruthy();
    }
    expect(results.length).toBeGreaterThan(0);
  });

  it('fails the connector only when EVERY target failed', async () => {
    const degraded: string[] = [];
    const context: ConnectorContext = {
      runtime: fixtureRuntime({}),
      env: {},
      log: () => {},
      degraded: (reason) => degraded.push(reason),
    };
    await expect(greenhouse.fetch(context)).rejects.toThrow(/all \d+ greenhouse targets failed/);
  });
});

describe('keyed connectors', () => {
  const KEYS: Record<string, Record<string, string>> = {
    adzuna: { ADZUNA_APP_ID: 'a', ADZUNA_APP_KEY: 'b' },
    careerjet: { CAREERJET_AFFID: 'a' },
    jooble: { JOOBLE_KEY: 'a' },
    usajobs: { USAJOBS_KEY: 'a', USAJOBS_EMAIL: 'b@c.d' },
  };

  it.each([adzuna, careerjet, jooble, usajobs])('$name skips when its key is absent', (connector) => {
    const reason = connector.skip?.({});
    expect(reason).toMatch(/not set in \.env\.local/);
    // The notice must name the variable to set — and never the value of anything.
    expect(reason).toMatch(/[A-Z_]{4,}/);
  });

  it.each([adzuna, careerjet, jooble, usajobs])('$name runs once its key is present', (connector) => {
    expect(connector.skip?.(KEYS[connector.name])).toBeNull();
  });
});

describe('fixture recorder', () => {
  it('refuses to record a response whose URL carries a credential', async () => {
    const sink: Fixture = {};
    const recorder = recordingRuntime(stubRuntime('{"jobs":[]}'), sink);

    // Query-string credential (Adzuna shape).
    await recorder.fetchText('https://api.test/search?app_key=SUPERSECRET');
    // Path credential (Jooble shape) — invisible to a query-string check, which is exactly
    // why those sources pass `redactUrl`.
    await recorder.fetchText('https://jooble.test/api/SUPERSECRET', {
      redactUrl: 'https://jooble.test/api/[key]',
    });

    expect(JSON.stringify(sink)).not.toContain('SUPERSECRET');
    expect(Object.keys(sink)).toEqual([]);
  });

  it('does record an ordinary URL', async () => {
    const sink: Fixture = {};
    const recorder = recordingRuntime(stubRuntime('{"jobs":[{"a":1},{"a":2},{"a":3}]}'), sink);
    await recorder.fetchText('https://api.test/jobs?content=true');
    expect(Object.keys(sink)).toEqual(['https://api.test/jobs?content=true']);
    // ...trimmed, so a full board does not become a megabyte in the repo.
    expect(JSON.parse(sink['https://api.test/jobs?content=true']).jobs).toHaveLength(2);
  });
});

describe('remotive', () => {
  it('is disabled because remotive.com/robots.txt disallows /api/*', () => {
    expect(remotive.skip?.({})).toMatch(/robots\.txt disallows \/api\/\*/);
  });
});

describe('simplify README table parser', () => {
  const NOW = Date.parse('2026-08-18T00:00:00Z');

  it('carries the company down through ↳ rows', () => {
    const rows = parseReadmeTable(
      [
        '<table><thead><tr><th>Company</th></tr></thead><tbody>',
        '<tr><td><strong><a href="https://simplify.jobs/c/Acme">Acme</a></strong></td>',
        '<td>Software Engineer Intern</td><td>Atlanta, GA</td>',
        '<td><a href="https://acme.test/apply/1?utm_source=Simplify&ref=Simplify">Apply</a></td><td>0d</td></tr>',
        '<tr><td>↳</td><td>Data Science Intern</td><td>Phoenix, AZ</td>',
        '<td><a href="https://acme.test/apply/2">Apply</a></td><td>3d</td></tr>',
        '<tr><td>↳</td><td>Closed Role</td><td>Remote</td><td>🔒</td><td>1mo</td></tr>',
        '</tbody></table>',
      ].join('\n'),
      NOW,
    );

    expect(rows).toHaveLength(2); // the locked row has no apply link
    expect(rows.map((row) => row.company)).toEqual(['Acme', 'Acme']);
    expect(rows[1].title).toBe('Data Science Intern');
    // Simplify's referral params are stripped so the same row yields the same URL every run.
    expect(rows[0].sourceUrl).toBe('https://acme.test/apply/1');
    expect(rows[1].postedAt).toBe(NOW - 3 * 86_400_000);
  });
});

describe('HN row marking', () => {
  it('tags every row `hn` so a later LLM pass can find them all', async () => {
    const { context } = replay('hn');
    const results = await hn.fetch(context);
    expect(results.length).toBeGreaterThan(0);
    for (const posting of results) expect(posting.source).toBe('hn');
  });

  it('logs how many comments it refused to extract rather than guessing', async () => {
    const { context, logs } = replay('hn');
    await hn.fetch(context);
    const summary = logs.find((line) => 'skippedUnextractable' in line);
    expect(summary?.skippedUnextractable).toBeTypeOf('number');
  });
});
