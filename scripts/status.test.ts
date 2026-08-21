import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import { createRuntime, type Connector, type ConnectorPosting } from '../lib/runtime.ts';
import { runIngest } from './ingest.ts';
import { collectStatus, duration, formatStatus, type ConnectorStatus, type Status } from './status.ts';

const CYCLE = 30 * 60 * 1000;
const T0 = Date.parse('2026-08-18T09:00:00Z');
const silent = (): void => {};

function job(source: string, url: string): ConnectorPosting {
  return {
    source,
    sourceKind: 'ats',
    sourceUrl: url,
    postedAt: T0 - 24 * 60 * 60 * 1000,
    company: 'Acme Inc.',
    title: source === 'fast' ? 'Product Designer' : 'Backend Engineer',
    location: 'San Francisco, CA',
    description: 'Work at Acme.',
  };
}

const fast: Connector = { name: 'fast', kind: 'ats', fetch: async () => [job('fast', 'https://a.test/1')] };
const slow: Connector = {
  name: 'slow',
  kind: 'aggregator',
  minIntervalMs: 6 * 60 * 60 * 1000,
  fetch: async () => [job('slow', 'https://b.test/1')],
};
const keyed: Connector = {
  name: 'keyed',
  kind: 'aggregator',
  skip: () => 'SOME_KEY not set in .env.local',
  fetch: async () => [],
};

async function seeded(): Promise<Db> {
  const db = openDb(':memory:', { migrate: true });
  await runIngest({
    connectors: [fast, slow, keyed],
    db,
    runtime: createRuntime({ minGapMs: 0 }),
    runId: 'run-0',
    env: {},
    log: silent,
    now: () => T0,
  });
  return db;
}

describe('npm run status', () => {
  it('answers "is it working" per connector: last run, what it brought, when it goes again', async () => {
    const db = await seeded();
    const status = collectStatus(db, {
      connectors: [fast, slow, keyed],
      env: {},
      now: T0 + CYCLE,
    });
    const rows = Object.fromEntries(status.connectors.map((row) => [row.connector, row]));

    expect(rows.fast).toMatchObject({ lastStatus: 'ok', fetched: 1, newPostings: 1, live: 1, dueInMs: null });
    // Polled 30 minutes ago on a 6-hour interval: five and a half hours still to wait, less
    // the minute of slack that stops a cycle landing a second early from skipping it.
    expect(rows.slow).toMatchObject({ lastStatus: 'ok', dueInMs: 5.5 * 60 * 60 * 1000 - 60_000 });
    // A connector that cannot run reports why, and never reports as due.
    expect(rows.keyed).toMatchObject({ lastStatus: null, disabled: 'SOME_KEY not set in .env.local' });

    expect(status.totals).toMatchObject({ postings: 2, live: 2, delisted: 0, ghosted: 0, deadLink: 0 });
    expect(status.recent[0]).toMatchObject({ runId: 'run-0', ok: 2, newPostings: 2 });
  });

  it('counts a delisted posting out of `live` but keeps it in the total', async () => {
    const db = await seeded();
    db.update(postings).set({ delistedAt: new Date(T0), delistedReason: 'linkcheck' }).run();
    const status = collectStatus(db, { connectors: [fast, slow], env: {}, now: T0 + CYCLE });

    expect(status.totals).toMatchObject({ postings: 2, live: 0, delisted: 2, ghosted: 0, deadLink: 2 });
    expect(status.connectors.map((row) => row.live)).toEqual([0, 0]);
  });

  it('renders a table a human can read at a glance', async () => {
    const db = await seeded();
    const text = formatStatus(
      collectStatus(db, { connectors: [fast, slow, keyed], env: {}, now: T0 + CYCLE }),
    );

    expect(text).toMatch(/^connector\s+last\s+when\s+fetched\s+new\s+live\s+next$/m);
    expect(text).toMatch(/^fast\s+ok\s+30m ago\s+1\s+1\s+1\s+every cycle$/m);
    expect(text).toMatch(/^slow\s+ok\s+30m ago\s+1\s+1\s+1\s+in 5h 29m$/m);
    expect(text).toMatch(/^keyed\s+off\s+never\s+0\s+0\s+0\s+-$/m);
    expect(text).toMatch(/^not running\n  keyed: SOME_KEY not set in \.env\.local$/m);
    // Explained once, under "not running" — not a second time as an error to act on.
    expect(text).not.toContain('errors on last run');
    expect(text).toContain('postings  2 total · 2 live');
    expect(text).toContain('delisted  0 total · 0 gone from source · 0 dead link');
  });

  it.each([
    [0, '0m'],
    [90 * 1000, '2m'],
    [59 * 60 * 1000, '59m'],
    [60 * 60 * 1000, '1h 0m'],
    [5.5 * 60 * 60 * 1000, '5h 30m'],
    [26 * 60 * 60 * 1000, '1d 2h'],
  ])('duration(%i) = %s', (ms, expected) => {
    expect(duration(ms)).toBe(expected);
  });
});

// A robots.txt refusal is policy, not a fault. smartrecruiters sat in every status table as
// ERROR — indistinguishable from a real outage — because the per-target refusal kind was
// discarded before the aggregate "all N targets failed" throw. The table now says `refused`
// when every failing target was refused by robots.txt; a genuine failure stays ERROR.
describe('a robots refusal is not an outage', () => {
  const row = (over: Partial<ConnectorStatus>): ConnectorStatus => ({
    connector: 'x', disabled: null, lastStatus: 'error', lastRunAt: T0, lastOkAt: null,
    error: null, fetched: 0, newPostings: 0, merged: 0, live: 0, dueInMs: null,
    minIntervalMs: null, ...over,
  });
  const status = (connectors: ConnectorStatus[]): Status => ({
    now: T0, connectors,
    totals: { postings: 0, live: 0, delisted: 0, ghosted: 0, deadLink: 0, enriched: 0, design: 0, engineering: 0 },
    recent: [],
  });

  it('renders refused when the failure was robots.txt, ERROR otherwise', () => {
    const text = formatStatus(status([
      row({ connector: 'smartrecruiters', error: 'all 7 smartrecruiters targets refused by robots.txt' }),
      row({ connector: 'broken', error: 'all 3 broken targets failed' }),
    ]));
    expect(text).toMatch(/^smartrecruiters\s+refused\s/m);
    expect(text).toMatch(/^broken\s+ERROR\s/m);
  });
});
