/**
 * The enrichment pass: iterate postings, extract deterministically, write the results back.
 *
 * No model, no network, no key, no cost — `lib/extract.ts` is pure functions over the row.
 * There is no cache and no spend cap because there is nothing to bill and nothing to save:
 * a full pass over the whole corpus is seconds, and re-running after a rule change is the
 * only way the change reaches the rows it should.
 *
 * `runEnrich` takes its database as an argument so `enrich.test.ts` can drive the whole
 * thing against an in-memory database.
 */

import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

// Extensions are explicit: `npm run enrich` is plain `node`, whose type stripping does no
// extension resolution. Extensionless specifiers only work under vitest and Next.
import * as schema from '../lib/db/schema.ts';
import { extract, toStored } from '../lib/extract.ts';
import { normalizeLocation } from '../lib/normalize.ts';

const { postings } = schema;

export type WorkieDatabase = BetterSQLite3Database<typeof schema>;

export interface EnrichStats {
  processed: number;
  stored: number;
  dropped: number;
  /** Dropped because the title or body says senior / staff / lead / 5+ years. */
  seniorDrops: number;
  /** Dropped because the role is neither design nor engineering. */
  trackDrops: number;
  /** Postings with no description at all: classified on the title alone, not skipped. */
  titleOnly: number;
  durationMs: number;
}

/**
 * Every posting, every run. The old pass skipped rows whose `description_hash` was unchanged
 * because each one cost an API call; extraction costs nothing, so skipping would only mean a
 * rule change never reaches the rows it was written for.
 */
/** The geo columns, derived from the display string so the two can never disagree. */
function geoColumns(location: string) {
  const geo = normalizeLocation(location);
  return { cityNorm: geo.city_norm, state: geo.state, country: geo.country, isRemote: geo.is_remote };
}

export function runEnrich(db: WorkieDatabase): EnrichStats {
  const startedAt = Date.now();
  const rows = db
    .select({
      id: postings.id,
      title: postings.title,
      description: postings.description,
      sourceFields: postings.sourceFields,
    })
    .from(postings)
    .all();

  const stats: EnrichStats = {
    processed: 0,
    stored: 0,
    dropped: 0,
    seniorDrops: 0,
    trackDrops: 0,
    titleOnly: 0,
    durationMs: 0,
  };
  const enrichedAt = new Date();

  db.transaction((tx) => {
    for (const row of rows) {
      // A posting with no body is classified on its title alone rather than skipped. Silently
      // leaving ~8% of the corpus unenriched would make it invisible in both tabs, which is
      // indistinguishable from losing it.
      if (!row.description) stats.titleOnly += 1;

      const extraction = extract(row);
      const found = toStored(extraction, row.description);

      // A dropped posting keeps its row — `posting_sources` hangs off it and the ghost pass
      // still needs it — but stores no extraction. `track` stays NULL, and neither tab can
      // select a NULL track, so a senior or off-track posting is unreachable from the UI.
      tx.update(postings)
        .set({
          enrichedAt,
          track: found?.track ?? null,
          seniority: found?.seniority ?? null,
          employmentType: found?.employment_type ?? null,
          internshipSeason: found?.internship_season ?? null,
          paid: found?.paid ?? null,
          workMode: found?.work_mode ?? null,
          location: found?.location ?? null,
          /**
           * Extraction is the only writer of `location`, and the geo columns are what the
           * location rules in `query.ts` actually read — so writing one without the other is
           * how a row ends up displaying "London" while being filtered as San Francisco.
           * 288 live rows were in exactly that state.
           *
           * Only when extraction produced a location: `found.location` is NULL for most rows,
           * and recomputing from NULL would erase the geo that `ingest` derived from the ATS's
           * own spelling. Nulling the display string while keeping those columns is the
           * existing behaviour and stays — `backfill:locations` skips rows with no string for
           * the same reason.
           */
          ...(found?.location ? geoColumns(found.location) : {}),
          payRateMin: found?.pay_rate?.min ?? null,
          payRateMax: found?.pay_rate?.max ?? null,
          payRatePeriod: found?.pay_rate?.period ?? null,
          expectedGrad: found?.expected_grad ?? null,
          summary: found?.summary ?? null,
          responsibilities: found?.responsibilities ?? null,
          skills: found?.skills ?? null,
          education: found?.education ?? null,
          badges: found?.badges ?? null,
        })
        .where(eq(postings.id, row.id))
        .run();

      stats.processed += 1;
      if (found) {
        stats.stored += 1;
        continue;
      }
      stats.dropped += 1;
      if (extraction.seniority === 'senior+') stats.seniorDrops += 1;
      else stats.trackDrops += 1;
    }
  });

  stats.durationMs = Date.now() - startedAt;
  return stats;
}

export function formatStats(stats: EnrichStats): string {
  return [
    `enrich: ${stats.processed} processed`,
    `${stats.stored} stored`,
    `${stats.dropped} dropped (${stats.seniorDrops} senior, ${stats.trackDrops} off-track)`,
    `${stats.titleOnly} title-only`,
    `${(stats.durationMs / 1000).toFixed(1)}s`,
  ].join(', ');
}

function main(): void {
  const sqlite = new Database(process.env.WORKIE_DB ?? 'workie.db');
  try {
    console.log(formatStats(runEnrich(drizzle(sqlite, { schema }))));
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
