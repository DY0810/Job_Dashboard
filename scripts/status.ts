/**
 * `npm run status` — is this thing working?
 *
 * One table, one row per connector, answering the three questions you actually have at 9am:
 * did it run, did it bring anything back, and when does it go again. Everything is derived
 * from `connector_runs` and `postings`; nothing here writes.
 *
 * The column that earns its place is `next`. With per-connector minimum intervals, "hn has
 * not run in four hours" is the system working as designed, and without somewhere to read
 * the cadence off you cannot tell that from a connector that has quietly stopped.
 *
 *   npm run status
 *   npm run status -- --runs=5      the last N runs per connector instead of the last one
 */

import { pathToFileURL } from 'node:url';

import { and, desc, eq, gte, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

import { cutoffTimestamp } from '../lib/dedupe.ts';
import { openDb, type Db } from '../lib/db/index.ts';
import { connectorRuns, postings, postingSources } from '../lib/db/schema.ts';
import { connectors as allConnectors } from './connectors/index.ts';
import { dueIn, lastSuccessByConnector } from './ingest.ts';
import type { Connector } from '../lib/runtime.ts';

export interface ConnectorStatus {
  connector: string;
  /** Why this connector is not going to run, if it is not. */
  disabled: string | null;
  lastStatus: 'ok' | 'error' | null;
  lastRunAt: number | null;
  lastOkAt: number | null;
  error: string | null;
  fetched: number;
  newPostings: number;
  merged: number;
  /** Postings this connector is a source of that are not delisted and inside the 60-day window. */
  live: number;
  /** ms until it may next be polled, or null when it has no minimum interval. */
  dueInMs: number | null;
  minIntervalMs: number | null;
}

export interface Status {
  now: number;
  connectors: ConnectorStatus[];
  totals: {
    postings: number;
    live: number;
    delisted: number;
    /** Of the delisted: gone from their sources vs. apply link dead. */
    ghosted: number;
    deadLink: number;
    enriched: number;
    design: number;
    engineering: number;
  };
  /** Postings added across the last `runs` runs, most recent first. */
  recent: { runId: string; startedAt: number; connectors: number; ok: number; newPostings: number }[];
}

export function collectStatus(
  db: Db,
  options: { connectors?: Connector[]; runs?: number; env?: Record<string, string | undefined>; now?: number } = {},
): Status {
  const list = options.connectors ?? allConnectors;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now();
  const lastOk = lastSuccessByConnector(db);
  const cutoff = new Date(cutoffTimestamp(now));

  // Live postings per connector, in one grouped query rather than one query per connector.
  const liveBySource = new Map(
    db
      .select({ source: postingSources.source, count: sql<number>`count(distinct ${postingSources.postingId})` })
      .from(postingSources)
      .innerJoin(postings, eq(postings.id, postingSources.postingId))
      .where(and(isNull(postings.delistedAt), gte(postings.postedAt, cutoff)))
      .groupBy(postingSources.source)
      .all()
      .map((row) => [row.source, row.count] as const),
  );

  const connectors = list.map((connector): ConnectorStatus => {
    const last = db
      .select()
      .from(connectorRuns)
      .where(eq(connectorRuns.connector, connector.name))
      .orderBy(desc(connectorRuns.startedAt))
      .limit(1)
      .get();
    const ok = lastOk.get(connector.name);
    return {
      connector: connector.name,
      disabled: connector.skip?.(env) ?? null,
      lastStatus: last?.status ?? null,
      lastRunAt: last?.startedAt.getTime() ?? null,
      lastOkAt: ok ?? null,
      error: last?.error ?? null,
      fetched: last?.fetched ?? 0,
      newPostings: last?.newPostings ?? 0,
      merged: last?.merged ?? 0,
      live: liveBySource.get(connector.name) ?? 0,
      dueInMs: connector.minIntervalMs === undefined ? null : dueIn(connector, ok, now),
      minIntervalMs: connector.minIntervalMs ?? null,
    };
  });

  const count = (where?: SQL): number =>
    db.select({ n: sql<number>`count(*)` }).from(postings).where(where).get()!.n;

  const totals = {
    postings: count(),
    // NOT the number the two tabs show. `lib/query.ts:visible()` also drops `senior+` and
    // anything with a null track, and each tab then selects its own — this is the corpus
    // that survived ingest and the ghost pass, which is what an ops readout is about.
    live: count(and(isNull(postings.delistedAt), gte(postings.postedAt, cutoff))),
    delisted: count(isNotNull(postings.delistedAt)),
    ghosted: count(eq(postings.delistedReason, 'ghost')),
    deadLink: count(eq(postings.delistedReason, 'linkcheck')),
    enriched: count(isNotNull(postings.enrichedAt)),
    design: count(eq(postings.track, 'design')),
    engineering: count(eq(postings.track, 'engineering')),
  };

  const recent = db
    .select({
      runId: connectorRuns.runId,
      startedAt: sql<number>`max(${connectorRuns.startedAt})`,
      connectors: sql<number>`count(*)`,
      ok: sql<number>`sum(${connectorRuns.status} = 'ok')`,
      // Counted off `postings`, not `sum(connector_runs.new_postings)`: that column is bumped
      // once per SOURCE row, so a posting first seen with three sources would count as three.
      newPostings: sql<number>`(select count(*) from ${postings} where ${postings.firstSeenRun} = ${connectorRuns.runId})`,
    })
    .from(connectorRuns)
    .groupBy(connectorRuns.runId)
    .orderBy(desc(sql`max(${connectorRuns.startedAt})`))
    .limit(options.runs ?? 3)
    .all();

  return { now, connectors, totals, recent };
}

// ---------------------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------------------

/** "4h 12m ago" · "never". Coarse on purpose: nobody is reading this to the second. */
export function ago(at: number | null, now: number): string {
  if (at === null) return 'never';
  return `${duration(now - at)} ago`;
}

export function duration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

function pad(value: string, width: number, right = false): string {
  return right ? value.padStart(width) : value.padEnd(width);
}

export function formatStatus(status: Status): string {
  const rows = status.connectors.map((connector) => {
    const state = connector.disabled
      ? 'off'
      : connector.lastStatus === null
        ? '-'
        : connector.lastStatus === 'ok'
          ? 'ok'
          : // Only robots refusals ever put "robots.txt" in an error — the aggregate
            // "refused by robots.txt" and the runtime's raw "robots.txt disallows <url>".
            // Policy, not fault; `refused` keeps ERROR meaning "something is broken".
            /robots\.txt/.test(connector.error ?? '')
            ? 'refused'
            : 'ERROR';
    // The disabled reason is a sentence; it goes in the footer rather than stretching the
    // table past a terminal's width for the sake of four rows.
    const next = connector.disabled
      ? '-'
      : connector.dueInMs === null
        ? 'every cycle'
        : connector.dueInMs === 0
          ? 'due now'
          : `in ${duration(connector.dueInMs)}`;
    return [
      connector.connector,
      state,
      ago(connector.lastRunAt, status.now),
      String(connector.fetched),
      String(connector.newPostings),
      String(connector.live),
      next,
    ];
  });

  const head = ['connector', 'last', 'when', 'fetched', 'new', 'live', 'next'];
  const right = [false, false, false, true, true, true, false];
  const width = head.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length)),
  );
  const line = (cells: string[]): string =>
    cells.map((cell, column) => pad(cell, width[column], right[column])).join('  ').trimEnd();

  // A connector that is now disabled keeps whatever error it last ran with, which is history
  // rather than something to act on — it is already explained under "not running" below.
  const errors = status.connectors
    .filter((connector) => !connector.disabled && connector.lastStatus === 'error' && connector.error)
    .map((connector) => `  ${connector.connector}: ${connector.error}`);

  const disabled = status.connectors
    .filter((connector) => connector.disabled)
    .map((connector) => `  ${connector.connector}: ${connector.disabled}`);

  const { totals } = status;
  return [
    line(head),
    line(width.map((n) => '-'.repeat(n))),
    ...rows.map(line),
    '',
    `postings  ${totals.postings} total · ${totals.live} live · ${totals.enriched} enriched`,
    `delisted  ${totals.delisted} total · ${totals.ghosted} gone from source · ${totals.deadLink} dead link`,
    `tracks    ${totals.design} design · ${totals.engineering} engineering`,
    '',
    'recent runs',
    ...status.recent.map(
      (run) =>
        `  ${new Date(run.startedAt).toISOString().replace('T', ' ').slice(0, 16)}  ` +
        `${run.ok}/${run.connectors} ok  +${run.newPostings} new`,
    ),
    ...(errors.length > 0 ? ['', 'errors on last run', ...errors] : []),
    ...(disabled.length > 0 ? ['', 'not running', ...disabled] : []),
  ].join('\n');
}

function main(): void {
  const raw = process.argv.slice(2).find((arg) => arg.startsWith('--runs='));
  const runs = raw === undefined ? undefined : Number.parseInt(raw.slice('--runs='.length), 10);
  if (runs !== undefined && (!Number.isFinite(runs) || runs <= 0)) throw new Error(`bad --runs: ${raw}`);
  console.log(formatStatus(collectStatus(openDb(), { runs })));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
