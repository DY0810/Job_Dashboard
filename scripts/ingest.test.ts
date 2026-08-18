import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../lib/db/index.ts';
import { connectorRuns, postingSources, postings } from '../lib/db/schema.ts';
import { createRuntime, type Connector, type ConnectorPosting, type Runtime } from '../lib/runtime.ts';
import { main, runIngest } from './ingest.ts';
import { keyedConnectors } from './connectors/keyed.ts';

function memoryDb(): Db {
  return openDb(':memory:', { migrate: true });
}

const POSTED = Date.parse('2026-08-01T00:00:00Z');

function posting(overrides: Partial<ConnectorPosting> = {}): ConnectorPosting {
  return {
    source: 'healthy',
    sourceKind: 'ats',
    sourceUrl: 'https://boards.test/jobs/1',
    postedAt: POSTED,
    company: 'Acme Inc.',
    title: 'Product Designer',
    location: 'San Francisco, CA',
    description: 'Design things at Acme.',
    ...overrides,
  };
}

/** The three fake connectors the Phase 2 gate calls for. */
const healthy: Connector = {
  name: 'healthy',
  kind: 'ats',
  fetch: async () => [
    posting(),
    posting({ sourceUrl: 'https://boards.test/jobs/2', title: 'Backend Engineer' }),
  ],
};

const fiveHundred: Connector = {
  name: 'five-hundred',
  kind: 'aggregator',
  fetch: async (context) => {
    await context.runtime.fetchJson('https://broken.test/jobs', { respectRobots: false });
    return [];
  },
};

const hanging: Connector = {
  name: 'hanging',
  kind: 'aggregator',
  fetch: async (context) => {
    await context.runtime.fetchJson('https://slow.test/jobs', {
      respectRobots: false,
      timeoutMs: 40,
    });
    return [];
  },
};

/** 500s for `broken.test`, never answers for `slow.test`. */
function flakyRuntime(): Runtime {
  return createRuntime({
    minGapMs: 0,
    retries: 0,
    fetchImpl: (url, init) =>
      url.startsWith('https://broken.test')
        ? Promise.resolve(new Response('{}', { status: 500 }))
        : new Promise((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
  });
}

const silent = (): void => {};

describe('connector isolation (Phase 2 gate)', () => {
  it('one healthy + one 500 + one hang: the run completes, records three rows, exits 0', async () => {
    const db = memoryDb();
    const result = await runIngest({
      connectors: [healthy, fiveHundred, hanging],
      db,
      runtime: flakyRuntime(),
      runId: 'run-1',
      env: {},
      log: silent,
    });

    expect(result.exitCode).toBe(0);

    const rows = db.select().from(connectorRuns).all();
    expect(rows).toHaveLength(3);
    expect(Object.fromEntries(rows.map((row) => [row.connector, row.status]))).toEqual({
      healthy: 'ok',
      'five-hundred': 'error',
      hanging: 'error',
    });
    expect(rows.find((row) => row.connector === 'five-hundred')?.error).toMatch(/HTTP 500/);
    expect(rows.find((row) => row.connector === 'hanging')?.error).toMatch(/timeout after 40ms/);

    // The healthy connector's postings are persisted despite the other two failing.
    expect(db.select().from(postings).all()).toHaveLength(2);
    expect(rows.find((row) => row.connector === 'healthy')?.newPostings).toBe(2);
  });

  it('exits 1 only when every connector failed', async () => {
    const result = await runIngest({
      connectors: [fiveHundred, hanging],
      db: memoryDb(),
      runtime: flakyRuntime(),
      runId: 'run-all-fail',
      env: {},
      log: silent,
    });
    expect(result.exitCode).toBe(1);
  });

  it('a run where nothing was eligible to start is not a failure', async () => {
    const result = await runIngest({
      connectors: keyedConnectors,
      db: memoryDb(),
      runtime: flakyRuntime(),
      runId: 'run-empty',
      env: {},
      log: silent,
    });
    expect(result.exitCode).toBe(0);
    expect(result.runs).toHaveLength(0);
  });
});

describe('keyed connectors without a key', () => {
  it('skip cleanly, write NO connector_runs row, and leave the run exiting 0', async () => {
    const db = memoryDb();
    const lines: Record<string, unknown>[] = [];
    const result = await runIngest({
      connectors: [healthy, ...keyedConnectors],
      db,
      runtime: flakyRuntime(),
      runId: 'run-keyless',
      env: {},
      log: (record) => lines.push(record),
    });

    expect(result.exitCode).toBe(0);
    expect(result.skipped.map((entry) => entry.connector).sort()).toEqual([
      'adzuna',
      'careerjet',
      'jooble',
      'usajobs',
    ]);
    for (const entry of result.skipped) expect(entry.reason).toMatch(/not set in \.env\.local/);

    // A skip is logged as a notice...
    expect(lines.filter((line) => line.status === 'skipped')).toHaveLength(4);
    // ...but writes no row, so ghost detection cannot read the silence as a real absence.
    expect(db.select().from(connectorRuns).all().map((row) => row.connector)).toEqual(['healthy']);
  });
});

describe('secrets never reach a log line', () => {
  it('a failing keyed connector logs no part of its credential', async () => {
    const db = memoryDb();
    const lines: string[] = [];
    await runIngest({
      connectors: keyedConnectors,
      db,
      runtime: createRuntime({
        minGapMs: 0,
        retries: 0,
        fetchImpl: async () => new Response('{}', { status: 500 }),
      }),
      runId: 'run-secret',
      env: {
        ADZUNA_APP_ID: 'app-id-1234',
        ADZUNA_APP_KEY: 'SUPERSECRETADZUNA',
        CAREERJET_AFFID: 'SUPERSECRETAFFID',
        JOOBLE_KEY: 'SUPERSECRETJOOBLE',
        USAJOBS_KEY: 'SUPERSECRETUSAJOBS',
        USAJOBS_EMAIL: 'someone@example.com',
      },
      log: (record) => lines.push(JSON.stringify(record)),
    });

    const captured = lines.join('\n');
    expect(captured).toMatch(/adzuna/);
    for (const secret of [
      'SUPERSECRETADZUNA',
      'SUPERSECRETAFFID',
      'SUPERSECRETJOOBLE',
      'SUPERSECRETUSAJOBS',
    ]) {
      expect(captured).not.toContain(secret);
    }

    // The stored error column is the other place a URL could leak.
    const stored = db.select().from(connectorRuns).all().map((row) => row.error ?? '').join('\n');
    expect(stored).not.toMatch(/SUPERSECRET/);
  });
});

describe('idempotency', () => {
  it('a second identical run creates ZERO new postings and bumps last_seen_run', async () => {
    const db = memoryDb();
    const options = { connectors: [healthy], db, runtime: flakyRuntime(), env: {}, log: silent };

    const first = await runIngest({ ...options, runId: 'run-A' });
    expect(first.runs[0].newPostings).toBe(2);
    expect(db.select().from(postings).all()).toHaveLength(2);

    const second = await runIngest({ ...options, runId: 'run-B' });
    expect(second.runs[0].newPostings).toBe(0);
    expect(second.runs[0].merged).toBe(2);
    expect(db.select().from(postings).all()).toHaveLength(2);

    const sources = db.select().from(postingSources).all();
    expect(sources).toHaveLength(2);
    for (const source of sources) {
      expect(source.lastSeenRun).toBe('run-B');
      expect(source.absenceCount).toBe(0);
    }
  });

  it('the same job from an aggregator merges into the ATS row rather than adding one', async () => {
    const db = memoryDb();
    const aggregator: Connector = {
      name: 'agg',
      kind: 'aggregator',
      fetch: async () => [
        posting({
          source: 'agg',
          sourceKind: 'aggregator',
          sourceUrl: 'https://aggregator.test/p/1',
          company: 'Acme',
          title: 'Product Designer',
          location: 'San Francisco',
          postedAt: POSTED + 86_400_000,
        }),
      ],
    };

    await runIngest({
      connectors: [healthy, aggregator],
      db,
      runtime: flakyRuntime(),
      runId: 'run-merge',
      env: {},
      log: silent,
    });

    expect(db.select().from(postings).all()).toHaveLength(2); // 2 healthy jobs, agg merged
    const merged = db.select().from(postings).all().find((row) => row.title === 'Product Designer')!;
    // The ATS URL wins canonical_url even though the aggregator also reported the job.
    expect(merged.canonicalUrl).toBe('https://boards.test/jobs/1');
    const sources = db
      .select()
      .from(postingSources)
      .all()
      .filter((row) => row.postingId === merged.id);
    expect(sources.map((row) => row.source).sort()).toEqual(['agg', 'healthy']);
  });
});

describe('review regressions', () => {
  it('a source with no usable date does not abort the batch or lose the other rows', async () => {
    const db = memoryDb();
    const undated: Connector = {
      name: 'undated',
      kind: 'aggregator',
      // `toEpochMs` yields NaN whenever a source omits its date field for one listing.
      fetch: async () => [
        posting({
          source: 'undated',
          sourceKind: 'aggregator',
          sourceUrl: 'https://agg.test/p/9',
          company: 'Undated Co',
          postedAt: Number.NaN,
        }),
      ],
    };

    const result = await runIngest({
      connectors: [healthy, undated],
      db,
      runtime: flakyRuntime(),
      runId: 'run-nan',
      env: {},
      log: silent,
    });

    expect(result.exitCode).toBe(0);
    // The healthy connector's rows survive, and the undated one is stored with a real date.
    expect(db.select().from(postings).all()).toHaveLength(3);
    for (const source of db.select().from(postingSources).all()) {
      expect(Number.isFinite(source.postedAt.getTime())).toBe(true);
    }
  });

  it('posted_at does not regress when the ATS connector is absent from a later run (finding D)', async () => {
    const db = memoryDb();
    const ATS_DATE = Date.parse('2026-07-20T00:00:00Z');
    const LIE = Date.parse('2026-04-01T00:00:00Z');

    const ats: Connector = {
      name: 'ats',
      kind: 'ats',
      fetch: async () => [
        posting({ source: 'ats', sourceUrl: 'https://boards.test/jobs/9', postedAt: ATS_DATE }),
      ],
    };
    const liar: Connector = {
      name: 'liar',
      kind: 'aggregator',
      fetch: async () => [
        posting({
          source: 'liar',
          sourceKind: 'aggregator',
          sourceUrl: 'https://liar.test/p/9',
          postedAt: LIE,
        }),
      ],
    };

    const base = { db, runtime: flakyRuntime(), env: {}, log: silent };
    await runIngest({ ...base, connectors: [ats, liar], runId: 'run-1' });
    expect(db.select().from(postings).all()[0].postedAt.getTime()).toBe(ATS_DATE);

    // Second run: the ATS connector is down, only the lying aggregator reports.
    await runIngest({ ...base, connectors: [liar], runId: 'run-2' });
    expect(db.select().from(postings).all()[0].postedAt.getTime()).toBe(ATS_DATE);
  });

  it('a bare --only or --since fails loudly instead of being read as absent', async () => {
    // `flag()` returns '' for a valueless flag; both paths must reject rather than quietly
    // fall back to "run everything" / "no date filter".
    await expect(
      runIngest({
        connectors: [healthy],
        db: memoryDb(),
        runtime: flakyRuntime(),
        runId: 'run-bare-only',
        only: '',
        env: {},
        log: silent,
      }),
    ).rejects.toThrow(/no connector named/);
    await expect(main(['--since'])).rejects.toThrow(/bad --since/);
  });
});

describe('flags', () => {
  it('--only runs one connector', async () => {
    const db = memoryDb();
    const result = await runIngest({
      connectors: [healthy, fiveHundred],
      db,
      runtime: flakyRuntime(),
      runId: 'run-only',
      only: 'healthy',
      env: {},
      log: silent,
    });
    expect(result.runs.map((run) => run.connector)).toEqual(['healthy']);
  });

  it('--dry-run fetches and normalizes but writes nothing at all', async () => {
    const db = memoryDb();
    const result = await runIngest({
      connectors: [healthy],
      db,
      runtime: flakyRuntime(),
      runId: 'run-dry',
      dryRun: true,
      env: {},
      log: silent,
    });
    expect(result.runs[0].fetched).toBe(2);
    expect(db.select().from(postings).all()).toHaveLength(0);
    expect(db.select().from(connectorRuns).all()).toHaveLength(0);
  });

  it('--since drops older postings without touching the connector', async () => {
    const db = memoryDb();
    const result = await runIngest({
      connectors: [healthy],
      db,
      runtime: flakyRuntime(),
      runId: 'run-since',
      since: POSTED + 1,
      env: {},
      log: silent,
    });
    expect(result.runs[0].fetched).toBe(2); // the connector still reported both
    expect(db.select().from(postings).all()).toHaveLength(0); // both are older than --since
  });
});
