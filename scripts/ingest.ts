/**
 * The ingest orchestrator (plan Phase 2).
 *
 * Runs every enabled connector under `Promise.allSettled`, writes one `connector_runs` row
 * per connector per run, and exits 0 if ANY connector succeeded — 1 only when all of them
 * failed. One connector can never abort a run; that is the whole point of this file.
 *
 *   npm run ingest
 *   npm run ingest -- --only=greenhouse
 *   npm run ingest -- --dry-run
 *   npm run ingest -- --since=2026-08-01
 *   npm run ingest -- --record            record connector fixtures for the offline suite
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { and, eq, inArray } from 'drizzle-orm';

import { dedupePostings, SOURCE_PRIORITY } from '../lib/dedupe.ts';
import { openDb, type Db } from '../lib/db/index.ts';
import { connectorRuns, postingSources, postings } from '../lib/db/schema.ts';
import type { SourceFields } from '../lib/extract.ts';
import {
  createRuntime,
  redact,
  type Connector,
  type ConnectorPosting,
  type Runtime,
} from '../lib/runtime.ts';
import { connectors as allConnectors } from './connectors/index.ts';
import { recordingRuntime, saveFixture, type Fixture } from './connectors/fixtures.ts';

export interface ConnectorRunRecord {
  connector: string;
  status: 'ok' | 'error';
  fetched: number;
  newPostings: number;
  merged: number;
  durationMs: number;
  error: string | null;
}

export interface IngestOptions {
  connectors: Connector[];
  db: Db;
  runtime: Runtime;
  runId: string;
  env?: Record<string, string | undefined>;
  only?: string;
  dryRun?: boolean;
  /** Drop postings older than this (epoch ms). Ingest never filters on anything else. */
  since?: number;
  log?: (record: Record<string, unknown>) => void;
  /** Per-connector runtime override — used by `--record` to wrap each in a recorder. */
  runtimeFor?: (connector: Connector) => Runtime;
}

export interface IngestResult {
  exitCode: number;
  runs: ConnectorRunRecord[];
  skipped: { connector: string; reason: string }[];
}

const jsonLog = (record: Record<string, unknown>): void => {
  console.log(JSON.stringify(record));
};

function message(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

export async function runIngest(options: IngestOptions): Promise<IngestResult> {
  const { db, runId } = options;
  const env = options.env ?? process.env;
  const log = options.log ?? jsonLog;
  const startedAt = new Date();

  const selected =
    options.only === undefined
      ? options.connectors
      : options.connectors.filter((connector) => connector.name === options.only);

  if (options.only !== undefined && selected.length === 0) {
    throw new Error(`no connector named ${options.only}`);
  }

  // A missing key is a skip, not an error — and a skip writes NO `connector_runs` row, so
  // ghost detection cannot read the silence as "this source dropped its postings" (finding C).
  const skipped: { connector: string; reason: string }[] = [];
  const active: Connector[] = [];
  for (const connector of selected) {
    const reason = connector.skip?.(env) ?? null;
    if (reason) {
      skipped.push({ connector: connector.name, reason });
      log({ run: runId, connector: connector.name, status: 'skipped', reason });
    } else {
      active.push(connector);
    }
  }

  interface Outcome {
    connector: Connector;
    record: ConnectorRunRecord;
    postings: ConnectorPosting[];
  }

  const settled = await Promise.allSettled(
    active.map(async (connector): Promise<Outcome> => {
      const began = Date.now();
      const context = {
        runtime: options.runtimeFor?.(connector) ?? options.runtime,
        env,
        log: (record: Record<string, unknown>) => log({ run: runId, ...record }),
      };
      try {
        const fetched = await connector.fetch(context);
        const fresh =
          options.since === undefined
            ? fetched
            : fetched.filter((posting) => !(posting.postedAt < options.since!));
        return {
          connector,
          postings: fresh,
          record: {
            connector: connector.name,
            status: 'ok',
            fetched: fetched.length,
            newPostings: 0,
            merged: 0,
            durationMs: Date.now() - began,
            error: null,
          },
        };
      } catch (error) {
        return {
          connector,
          postings: [],
          record: {
            connector: connector.name,
            status: 'error',
            fetched: 0,
            newPostings: 0,
            merged: 0,
            durationMs: Date.now() - began,
            // Carries the connector name (the `connector` field) and never a credential.
            error: message(error),
          },
        };
      }
    }),
  );

  // `Promise.allSettled` over a body that catches its own errors can still reject if the
  // harness itself throws; a rejected slot must not lose the connector's row.
  const outcomes: Outcome[] = settled.map((result, index) =>
    result.status === 'fulfilled'
      ? result.value
      : {
          connector: active[index],
          postings: [],
          record: {
            connector: active[index].name,
            status: 'error' as const,
            fetched: 0,
            newPostings: 0,
            merged: 0,
            durationMs: 0,
            error: message(result.reason),
          },
        },
  );

  const harvested = outcomes.filter((outcome) => outcome.record.status === 'ok');
  const counts = options.dryRun
    ? new Map<string, { newPostings: number; merged: number }>()
    : persist(
        db,
        harvested.flatMap((outcome) => outcome.postings),
        runId,
      );

  for (const outcome of outcomes) {
    const count = counts.get(outcome.record.connector);
    outcome.record.newPostings = count?.newPostings ?? 0;
    outcome.record.merged = count?.merged ?? 0;
    log({ run: runId, ...outcome.record });
  }

  if (!options.dryRun && outcomes.length > 0) {
    db.insert(connectorRuns)
      .values(
        outcomes.map((outcome) => ({
          runId,
          connector: outcome.record.connector,
          status: outcome.record.status,
          fetched: outcome.record.fetched,
          newPostings: outcome.record.newPostings,
          merged: outcome.record.merged,
          durationMs: outcome.record.durationMs,
          error: outcome.record.error,
          startedAt,
        })),
      )
      .run();
  }

  const failures = outcomes.filter((outcome) => outcome.record.status === 'error').length;
  const succeeded = outcomes.length - failures;
  const runs = outcomes.map((outcome) => outcome.record);

  log({
    run: runId,
    event: 'summary',
    connectors: outcomes.length,
    ok: succeeded,
    failed: failures,
    skipped: skipped.length,
    fetched: runs.reduce((total, run) => total + run.fetched, 0),
    newPostings: runs.reduce((total, run) => total + run.newPostings, 0),
    merged: runs.reduce((total, run) => total + run.merged, 0),
    dryRun: Boolean(options.dryRun),
  });

  // Exit 1 only when everything that ran failed. Nothing running at all is not a failure.
  return { exitCode: failures > 0 && succeeded === 0 ? 1 : 0, runs, skipped };
}

// ---------------------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------------------

type Counts = Map<string, { newPostings: number; merged: number }>;

function bump(counts: Counts, connector: string, key: 'newPostings' | 'merged'): void {
  const entry = counts.get(connector) ?? { newPostings: 0, merged: 0 };
  entry[key] += 1;
  counts.set(connector, entry);
}

function persist(db: Db, batch: ConnectorPosting[], runId: string): Counts {
  const counts: Counts = new Map();
  if (batch.length === 0) return counts;

  // Keep the best-ranked report of each URL for the display fields; dedupe collapses the
  // rest but only returns the source records, not the bodies they came with.
  const display = new Map<string, ConnectorPosting>();
  for (const posting of batch) {
    const existing = display.get(posting.sourceUrl);
    if (!existing || SOURCE_PRIORITY[posting.sourceKind] < SOURCE_PRIORITY[existing.sourceKind]) {
      display.set(posting.sourceUrl, posting);
    }
  }

  const deduped = dedupePostings(batch);

  db.transaction((tx) => {
    for (const post of deduped) {
      const urls = post.sources.map((source) => source.sourceUrl);
      // The dedupe contract (lib/dedupe.ts): match on a known source URL FIRST, because a run
      // where the ATS connector failed hands us the same job keyed on its aggregator identity.
      // Going straight to `dedupe_key` would insert a second row for a job we already have.
      const bySource = tx
        .select({ postingId: postingSources.postingId })
        .from(postingSources)
        .where(inArray(postingSources.sourceUrl, urls))
        .all();

      // ponytail: when this batch bridges two rows that used to be separate, we attach to the
      // first and leave the other for the ghost pass. Rewriting foreign keys to fold them is
      // a phase-10 concern and needs its own gate.
      let postingId: number | undefined = bySource[0]?.postingId;
      if (postingId === undefined) {
        postingId = tx
          .select({ id: postings.id })
          .from(postings)
          .where(eq(postings.dedupeKey, post.dedupeKey))
          .get()?.id;
      }

      const inserted = postingId === undefined;
      const best = display.get(post.sources[0].sourceUrl);
      const description =
        post.sources.map((source) => display.get(source.sourceUrl)?.description ?? '').find(Boolean) ?? '';
      const hasAts = post.sources.some((source) => source.sourceKind === 'ats');
      // Highest-priority source that actually answered with structured fields — an ATS, in
      // practice. `location` falls back to whatever the best source called the place, so a
      // row always has a display string even when no source structured anything.
      const structured = post.sources
        .map((source) => display.get(source.sourceUrl)?.sourceFields)
        .find((fields) => fields !== undefined);
      const location = structured?.location ?? (typeof best?.location === 'string' ? best.location : undefined);
      const sourceFields: SourceFields | null =
        structured || location ? { ...structured, ...(location ? { location } : {}) } : null;

      const shared = {
        company: best?.company ?? '',
        title: best?.title ?? '',
        companyNorm: post.companyNorm,
        titleNorm: post.titleNorm,
        locationKey: post.locationKey,
        cityNorm: post.location.city_norm,
        state: post.location.state,
        country: post.location.country,
        isRemote: post.location.is_remote,
      };

      if (postingId === undefined) {
        postingId = tx
          .insert(postings)
          .values({
            ...shared,
            dedupeKey: post.dedupeKey,
            canonicalUrl: post.canonicalUrl,
            postedAt: new Date(post.postedAt),
            firstSeenRun: runId,
            description: description || null,
            sourceFields,
          })
          .returning({ id: postings.id })
          .get().id;
      } else {
        const current = tx.select().from(postings).where(eq(postings.id, postingId)).get()!;
        // FINDING D, across runs. `dedupePostings` floors `posted_at` at the ATS date within
        // one batch, but on a run where the ATS connector was down the batch has no ATS
        // source and an aggregator's older (or fabricated) date would drag the stored value
        // back — permanently, since Math.min never recovers. Floor at the ATS date this
        // posting has already been seen with.
        const storedAts = tx
          .select({ postedAt: postingSources.postedAt })
          .from(postingSources)
          .where(
            and(
              eq(postingSources.postingId, postingId),
              eq(postingSources.sourcePriority, SOURCE_PRIORITY.ats),
            ),
          )
          .all()
          .map((row) => row.postedAt.getTime());
        const floor = storedAts.length > 0 ? Math.min(...storedAts) : Number.NEGATIVE_INFINITY;
        // The unique index on `dedupe_key` means we may only adopt a key nobody else holds.
        const keyTaken =
          current.dedupeKey !== post.dedupeKey &&
          tx.select({ id: postings.id }).from(postings).where(eq(postings.dedupeKey, post.dedupeKey)).get() !==
            undefined;

        tx.update(postings)
          .set({
            ...shared,
            dedupeKey: keyTaken ? current.dedupeKey : post.dedupeKey,
            // Only ever promote toward an ATS URL. If the ATS connector failed this run, the
            // batch's best source is an aggregator and the stored canonical must not regress.
            canonicalUrl: hasAts ? post.canonicalUrl : current.canonicalUrl,
            postedAt: new Date(
              Math.max(Math.min(current.postedAt.getTime(), post.postedAt), floor),
            ),
            description: description || current.description,
            // Only a run that ACTUALLY carried structured fields may replace them. Without
            // this, a run where the ATS connector was down but an aggregator reported the
            // same job writes `{location}` alone — non-null, so `??` would not fall back —
            // and silently drops the department, work mode and sections the ATS gave us.
            // Same hazard, and same shape of guard, as `posted_at` and `canonical_url` above.
            sourceFields: structured ? sourceFields : (current.sourceFields ?? sourceFields),
          })
          .where(eq(postings.id, postingId))
          .run();
      }

      for (const source of post.sources) {
        tx.insert(postingSources)
          .values({
            postingId,
            source: source.source,
            sourceUrl: source.sourceUrl,
            // HIGH: `toEpochMs` returns NaN for a date this source did not supply or that
            // did not parse, and `new Date(NaN)` fails `posted_at NOT NULL` — which would
            // roll back the whole batch and take every other connector's rows with it.
            // `post.postedAt` is finite by construction (dedupe falls back when nothing parsed).
            postedAt: new Date(Number.isFinite(source.postedAt) ? source.postedAt : post.postedAt),
            sourcePriority: source.sourcePriority,
            lastSeenRun: runId,
            absenceCount: 0,
          })
          .onConflictDoUpdate({
            target: [postingSources.postingId, postingSources.sourceUrl],
            set: { lastSeenRun: runId, absenceCount: 0, sourcePriority: source.sourcePriority },
          })
          .run();
        bump(counts, source.source, inserted ? 'newPostings' : 'merged');
      }
    }
  });

  return counts;
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const match = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const only = flag(argv, 'only');
  const dryRun = flag(argv, 'dry-run') !== undefined;
  const record = flag(argv, 'record') !== undefined;
  const sinceRaw = flag(argv, 'since');
  const since = sinceRaw === undefined ? undefined : Date.parse(sinceRaw);
  if (since !== undefined && !Number.isFinite(since)) throw new Error(`bad --since: ${sinceRaw}`);

  const runId = new Date().toISOString();
  const runtime = createRuntime();
  const db = openDb(undefined, { migrate: true });

  const sinks = new Map<string, Fixture>();
  const result = await runIngest({
    connectors: allConnectors,
    db,
    runtime,
    runId,
    only,
    dryRun,
    since,
    runtimeFor: record
      ? (connector) => {
          const sink: Fixture = {};
          sinks.set(connector.name, sink);
          return recordingRuntime(runtime, sink);
        }
      : undefined,
  });

  for (const [name, fixture] of sinks) {
    if (Object.keys(fixture).length > 0) saveFixture(name, fixture);
  }

  return result.exitCode;
}

// Run only when invoked as a script; importing this module (tests, tooling) must be inert.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await main();
}
