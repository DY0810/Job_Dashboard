/**
 * Phase 10's gate, and it is almost entirely negative tests.
 *
 * Everything here is driven through `runIngest` rather than by calling `runGhostPass`
 * directly, because the property under test is not "the SQL is right" — it is "the ghost pass
 * is only ever handed connectors that actually answered". A unit test of `runGhostPass` would
 * pass happily while ingest fed it the wrong list.
 */

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { GHOST_ABSENCE_THRESHOLD, isGhost } from '../lib/dedupe.ts';
import { openDb, type Db } from '../lib/db/index.ts';
import { connectorRuns, postings, postingSources } from '../lib/db/schema.ts';
import { createRuntime, type Connector, type ConnectorPosting } from '../lib/runtime.ts';
import { runGhostPass } from './ghost.ts';
import { runIngest } from './ingest.ts';

const HOUR = 60 * 60 * 1000;
const CYCLE = 30 * 60 * 1000;
const T0 = Date.parse('2026-08-18T09:00:00Z');

function memoryDb(): Db {
  return openDb(':memory:', { migrate: true });
}

function job(url: string, title = 'Product Designer'): ConnectorPosting {
  return {
    source: 'board',
    sourceKind: 'ats',
    sourceUrl: url,
    postedAt: Date.parse('2026-08-15T00:00:00Z'),
    company: 'Acme Inc.',
    title,
    location: 'San Francisco, CA',
    description: 'Design things at Acme.',
  };
}

/** A connector whose response and health the test drives run by run. */
function scripted(name: string, script: () => ConnectorPosting[]): Connector {
  return {
    name,
    kind: 'ats',
    fetch: async () => script(),
  };
}

const silent = (): void => {};

interface Harness {
  db: Db;
  /** Run one cycle at `T0 + cycle * CYCLE`. */
  cycle(n: number, connectors: Connector[]): Promise<void>;
  sources(): { source: string; absenceCount: number; sourceUrl: string }[];
  delistedAt(): Date | null;
}

function harness(): Harness {
  const db = memoryDb();
  return {
    db,
    async cycle(n, connectors) {
      await runIngest({
        connectors,
        db,
        runtime: createRuntime({ minGapMs: 0 }),
        runId: `run-${n}`,
        env: {},
        log: silent,
        now: () => T0 + n * CYCLE,
      });
    },
    sources: () =>
      db
        .select({
          source: postingSources.source,
          absenceCount: postingSources.absenceCount,
          sourceUrl: postingSources.sourceUrl,
        })
        .from(postingSources)
        .all(),
    delistedAt: () => db.select().from(postings).all()[0]?.delistedAt ?? null,
  };
}

const URL_A = 'https://boards.test/jobs/1';

describe('ghost detection, positive', () => {
  it('present, absent once, absent twice, back: delisted only on the second absence', async () => {
    const test = harness();
    let listing: ConnectorPosting[] = [job(URL_A)];
    const board = scripted('board', () => listing);

    await test.cycle(1, [board]);
    expect(test.sources()).toHaveLength(1);
    expect(test.delistedAt()).toBeNull();

    // Run 2 — gone from a SUCCESSFUL poll. One absence is not two.
    listing = [];
    await test.cycle(2, [board]);
    expect(test.sources()[0].absenceCount).toBe(1);
    expect(test.delistedAt()).toBeNull();

    // Run 3 — gone again. Now it is a ghost.
    await test.cycle(3, [board]);
    expect(test.sources()[0].absenceCount).toBe(GHOST_ABSENCE_THRESHOLD);
    expect(test.delistedAt()).toBeInstanceOf(Date);

    // Run 4 — back. The counter resets and `delisted_at` is cleared.
    listing = [job(URL_A)];
    await test.cycle(4, [board]);
    expect(test.sources()[0].absenceCount).toBe(0);
    expect(test.delistedAt()).toBeNull();
  });

  it('one live source keeps a posting listed even when the other has gone quiet', async () => {
    const test = harness();
    const aggregatorUrl = 'https://aggregator.test/p/1';
    let atsListing: ConnectorPosting[] = [job(URL_A)];
    const ats = scripted('board', () => atsListing);
    const agg = scripted('agg', () => [
      { ...job(aggregatorUrl), source: 'agg', sourceKind: 'aggregator' },
    ]);

    await test.cycle(1, [ats, agg]);
    expect(test.sources()).toHaveLength(2);

    atsListing = [];
    await test.cycle(2, [ats, agg]);
    await test.cycle(3, [ats, agg]);

    const counts = Object.fromEntries(test.sources().map((row) => [row.source, row.absenceCount]));
    expect(counts).toEqual({ board: GHOST_ABSENCE_THRESHOLD, agg: 0 });
    expect(isGhost(test.sources())).toBe(false);
    expect(test.delistedAt()).toBeNull();
  });
});

describe('ghost detection, negative — the ones that matter', () => {
  it('a source that ERRORS twice delists nothing and does not move the counter', async () => {
    const test = harness();
    let healthy = true;
    const board: Connector = {
      name: 'board',
      kind: 'ats',
      fetch: async () => {
        if (!healthy) throw new Error('HTTP 500 for https://boards.test/jobs');
        return [job(URL_A)];
      },
    };

    await test.cycle(1, [board]);
    expect(test.sources()[0].absenceCount).toBe(0);

    healthy = false;
    await test.cycle(2, [board]);
    await test.cycle(3, [board]);

    // A bad afternoon at one source must never wipe its inventory.
    expect(test.sources()[0].absenceCount).toBe(0);
    expect(test.delistedAt()).toBeNull();
    expect(
      test.db.select().from(connectorRuns).all().filter((row) => row.status === 'error'),
    ).toHaveLength(2);
  });

  it('a connector SKIPPED FOR CADENCE accrues no absence across the cycles it sits out', async () => {
    const test = harness();
    // Six hours, so it runs on cycle 1 and is then skipped for the next eleven.
    const slow: Connector = {
      name: 'board',
      kind: 'ats',
      minIntervalMs: 6 * HOUR,
      fetch: async () => [job(URL_A)],
    };

    for (let n = 1; n <= 12; n += 1) await test.cycle(n, [slow]);

    // Ran exactly once. Eleven cycles of silence, zero phantom absences, nothing delisted —
    // this is the hazard per-connector cadence introduced.
    expect(test.db.select().from(connectorRuns).all()).toHaveLength(1);
    expect(test.sources()[0].absenceCount).toBe(0);
    expect(test.delistedAt()).toBeNull();
  });

  it('a keyed connector SKIPPED FOR A MISSING KEY delists nothing', async () => {
    const test = harness();
    const board = scripted('board', () => [job(URL_A)]);
    const keyed: Connector = {
      name: 'keyed',
      kind: 'aggregator',
      skip: (env) => (env.SOME_KEY ? null : 'SOME_KEY not set in .env.local'),
      fetch: async () => [{ ...job('https://keyed.test/p/1'), source: 'keyed', sourceKind: 'aggregator' }],
    };

    // Seed a `keyed` source row while the key is present...
    await runIngest({
      connectors: [board, keyed],
      db: test.db,
      runtime: createRuntime({ minGapMs: 0 }),
      runId: 'run-0',
      env: { SOME_KEY: 'x' },
      log: silent,
      now: () => T0,
    });
    expect(test.sources()).toHaveLength(2);

    // ...then take it away. `keyed` writes no `connector_runs` row, so it cannot be read as
    // an absence however many cycles go by.
    for (let n = 1; n <= 4; n += 1) await test.cycle(n, [board, keyed]);

    const counts = Object.fromEntries(test.sources().map((row) => [row.source, row.absenceCount]));
    expect(counts).toEqual({ board: 0, keyed: 0 });
    expect(test.delistedAt()).toBeNull();
    expect(
      test.db.select().from(connectorRuns).all().filter((row) => row.connector === 'keyed'),
    ).toHaveLength(1);
  });

  it('does not clear a delisting linkcheck made — those postings were never ghosts here', async () => {
    const test = harness();
    const board = scripted('board', () => [job(URL_A)]);
    await test.cycle(1, [board]);

    // linkcheck's verdict: the apply URL serves a gone page even though the board still
    // lists the job. Its absence counts are zero, so the ghost pass has no claim on it.
    const marked = new Date(T0);
    test.db.update(postings).set({ delistedAt: marked }).run();

    await test.cycle(2, [board]);
    await test.cycle(3, [board]);

    expect(test.delistedAt()).toEqual(marked);
  });
});

describe('the SQL and lib/dedupe.ts agree on what a ghost is', () => {
  // `isGhost` is `sources.every(count >= 2)`; `ghost.ts` says `MIN(absence_count) >= 2` in
  // SQL. Two spellings of one rule drift, so this asserts they answer the same thing. The
  // `okConnectors` list names a connector with no source rows on purpose: the absence UPDATE
  // then touches nothing and the seeded counts are what the delist SQL is judged on.
  it.each([
    { counts: [0], ghost: false },
    { counts: [1], ghost: false },
    { counts: [2], ghost: true },
    { counts: [3], ghost: true },
    { counts: [2, 0], ghost: false },
    { counts: [0, 2], ghost: false },
    { counts: [2, 3], ghost: true },
  ])('$counts -> $ghost', async ({ counts, ghost }) => {
    const test = harness();
    const connectors = counts.map((_, index) =>
      scripted(`s${index}`, () => [
        { ...job(`https://s${index}.test/p/1`), source: `s${index}`, sourceKind: 'aggregator' as const },
      ]),
    );
    await test.cycle(1, connectors);
    expect(test.db.select().from(postings).all()).toHaveLength(1);

    for (const [index, count] of counts.entries()) {
      test.db
        .update(postingSources)
        .set({ absenceCount: count })
        .where(eq(postingSources.source, `s${index}`))
        .run();
    }

    runGhostPass(test.db, {
      runId: 'run-2',
      okConnectors: ['a-connector-with-no-sources'],
      wasGhost: new Set(),
      now: new Date(T0),
    });

    expect(test.sources().map((row) => row.absenceCount).sort()).toEqual([...counts].sort());
    expect(isGhost(test.sources())).toBe(ghost);
    expect(test.delistedAt() !== null).toBe(ghost);
  });
});
