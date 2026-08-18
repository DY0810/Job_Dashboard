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
  /** `delisted_at` of the posting carrying `sourceUrl`, or of the only posting when omitted. */
  delistedAt(sourceUrl?: string): Date | null;
  postingId(sourceUrl: string): number;
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
    delistedAt: (sourceUrl) => {
      const rows = db
        .select({ delistedAt: postings.delistedAt, sourceUrl: postingSources.sourceUrl })
        .from(postings)
        .innerJoin(postingSources, eq(postingSources.postingId, postings.id))
        .all();
      const match = sourceUrl === undefined ? rows[0] : rows.find((row) => row.sourceUrl === sourceUrl);
      return match?.delistedAt ?? null;
    },
    postingId: (sourceUrl) =>
      db.select().from(postingSources).all().find((row) => row.sourceUrl === sourceUrl)!.postingId,
  };
}

const URL_A = 'https://boards.test/jobs/1';

/**
 * A second job the board never drops.
 *
 * Absence is simulated by a board that still answers with a catalogue, minus one job — which
 * is what a real one does. Returning an EMPTY list instead would be a different scenario
 * entirely: `ghostEligible` bars a connector that fetched nothing from ageing anything,
 * because it cannot tell "the board is empty" from "we lost the board". See the test below.
 */
function anchor(source = 'board'): ConnectorPosting {
  return { ...job('https://boards.test/jobs/anchor', 'Staff Accountant'), source };
}

describe('ghost detection, positive', () => {
  it('present, absent once, absent twice, back: delisted only on the second absence', async () => {
    const test = harness();
    let listed = true;
    const board = scripted('board', () => (listed ? [job(URL_A), anchor()] : [anchor()]));
    const watched = () => test.sources().find((row) => row.sourceUrl === URL_A)!;

    await test.cycle(1, [board]);
    expect(test.delistedAt(URL_A)).toBeNull();

    // Run 2 — gone from a SUCCESSFUL poll. One absence is not two.
    listed = false;
    await test.cycle(2, [board]);
    expect(watched().absenceCount).toBe(1);
    expect(test.delistedAt(URL_A)).toBeNull();

    // Run 3 — gone again. Now it is a ghost.
    await test.cycle(3, [board]);
    expect(watched().absenceCount).toBe(GHOST_ABSENCE_THRESHOLD);
    expect(test.delistedAt(URL_A)).toBeInstanceOf(Date);

    // Run 4 — back. The counter resets and `delisted_at` is cleared.
    listed = true;
    await test.cycle(4, [board]);
    expect(watched().absenceCount).toBe(0);
    expect(test.delistedAt(URL_A)).toBeNull();
  });

  it('one live source keeps a posting listed even when the other has gone quiet', async () => {
    const test = harness();
    const aggregatorUrl = 'https://aggregator.test/p/1';
    let listed = true;
    const ats = scripted('board', () => (listed ? [job(URL_A), anchor()] : [anchor()]));
    const agg = scripted('agg', () => [
      { ...job(aggregatorUrl), source: 'agg', sourceKind: 'aggregator' },
    ]);

    await test.cycle(1, [ats, agg]);
    listed = false;
    await test.cycle(2, [ats, agg]);
    await test.cycle(3, [ats, agg]);

    const watched = test.sources().filter((row) => row.sourceUrl !== 'https://boards.test/jobs/anchor');
    const counts = Object.fromEntries(watched.map((row) => [row.source, row.absenceCount]));
    expect(counts).toEqual({ board: GHOST_ABSENCE_THRESHOLD, agg: 0 });
    expect(isGhost(watched)).toBe(false);
    expect(test.delistedAt(URL_A)).toBeNull();
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

  it('a connector that answered PARTIALLY delists nothing, even though the run is ok', async () => {
    const test = harness();
    // A fan-out connector: one of its company boards fails, the rest land. `atsConnector`
    // catches the failure so the other boards survive, and the run is `ok` with real
    // postings in it — the exact shape that would otherwise delist the missing board.
    let boardBFailing = false;
    const fanout: Connector = {
      name: 'board',
      kind: 'ats',
      fetch: async (context) => {
        if (!boardBFailing) return [job(URL_A), anchor()];
        context.degraded('company-b: fetch failed');
        return [anchor()];
      },
    };

    await test.cycle(1, [fanout]);
    boardBFailing = true;
    for (const n of [2, 3, 4, 5]) await test.cycle(n, [fanout]);

    const runs = test.db.select().from(connectorRuns).all();
    expect(runs.every((run) => run.status === 'ok')).toBe(true);
    expect(runs.at(-1)?.error).toMatch(/partial/);
    // Four "successful" runs without it, and it is still listed.
    expect(test.sources().find((row) => row.sourceUrl === URL_A)!.absenceCount).toBe(0);
    expect(test.delistedAt(URL_A)).toBeNull();
  });

  it('a connector that answered with ZERO postings delists nothing', async () => {
    const test = harness();
    // `body.jobs ?? []` turns a changed response shape into an empty array rather than a
    // throw. A source that returned nothing cannot tell us "the board is empty" from "we
    // lost the board", so it does not get to age anything.
    let broken = false;
    const board = scripted('board', () => (broken ? [] : [job(URL_A), anchor()]));

    await test.cycle(1, [board]);
    broken = true;
    for (const n of [2, 3, 4, 5]) await test.cycle(n, [board]);

    expect(test.db.select().from(connectorRuns).all().every((run) => run.status === 'ok')).toBe(true);
    expect(test.sources().every((row) => row.absenceCount === 0)).toBe(true);
    expect(test.delistedAt(URL_A)).toBeNull();
  });

  it('never undoes a delisting linkcheck made, however the absence counts move afterwards', async () => {
    const test = harness();
    let listed = true;
    const board = scripted('board', () => (listed ? [job(URL_A), anchor()] : [anchor()]));
    await test.cycle(1, [board]);

    // linkcheck's verdict: the apply URL serves a gone page even though the board still
    // lists the job, so its absence counts are zero.
    const marked = new Date(T0);
    test.db
      .update(postings)
      .set({ delistedAt: marked, delistedReason: 'linkcheck' })
      .where(eq(postings.id, test.postingId(URL_A)))
      .run();

    // Counts do not stand still. The board drops it too, which makes it a ghost by every
    // measure — and THEN relists it. Without `delisted_reason` this is the sequence that
    // clears linkcheck's mark and puts a dead apply link back in the UI for a week.
    listed = false;
    await test.cycle(2, [board]);
    await test.cycle(3, [board]);
    listed = true;
    await test.cycle(4, [board]);

    expect(test.sources().find((row) => row.sourceUrl === URL_A)!.absenceCount).toBe(0);
    expect(test.delistedAt(URL_A)).toEqual(marked);
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
      now: new Date(T0),
    });

    expect(test.sources().map((row) => row.absenceCount).sort()).toEqual([...counts].sort());
    expect(isGhost(test.sources())).toBe(ghost);
    expect(test.delistedAt() !== null).toBe(ghost);
  });
});
