/**
 * The enrichment pass: iterate un-enriched postings, classify them, write the results back.
 *
 * Cost behavior lives in `lib/classify.ts`; this script is the I/O around it — the SQLite
 * cache, the row updates, and the run log. `runEnrich` takes its database and its model
 * client as arguments so `enrich.test.ts` can drive the whole thing against an in-memory
 * database and a stub, with no network and no API key.
 */

import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

import {
  anthropicClassifier,
  CLASSIFY_MODEL,
  enrichPostings,
  parseSpendCap,
  type ClassificationCache,
  type ClassifyClient,
  type EnrichStats,
} from '../lib/classify';
import * as schema from '../lib/db/schema';

const { enrichmentCache, postings } = schema;

export type WorkyDatabase = BetterSQLite3Database<typeof schema>;

/**
 * The `enrichment_cache` table as a cache interface.
 *
 * Reads are scoped to the current model, so switching models re-classifies rather than
 * serving another model's answers; writes upsert, so the new model's row replaces the old
 * one instead of colliding with it forever (`content_hash` is the primary key).
 */
export function sqliteCache(db: WorkyDatabase, model: string = CLASSIFY_MODEL): ClassificationCache {
  return {
    get(contentHash) {
      const row = db
        .select({ classification: enrichmentCache.classification })
        .from(enrichmentCache)
        .where(and(eq(enrichmentCache.contentHash, contentHash), eq(enrichmentCache.model, model)))
        .get();
      return row?.classification ?? null;
    },
    set(contentHash, classification) {
      const createdAt = new Date();
      db.insert(enrichmentCache)
        .values({ contentHash, classification, model, createdAt })
        .onConflictDoUpdate({
          target: enrichmentCache.contentHash,
          set: { classification, model, createdAt },
        })
        .run();
    },
  };
}

export async function runEnrich(
  db: WorkyDatabase,
  client: ClassifyClient,
  options: { spendCapUsd?: number } = {},
): Promise<EnrichStats> {
  const rows = db
    .select({
      id: postings.id,
      title: postings.title,
      company: postings.company,
      description: postings.description,
    })
    .from(postings)
    .where(and(isNull(postings.enrichedAt), isNotNull(postings.description)))
    .all();

  const { results, stats } = await enrichPostings(rows, {
    client,
    cache: sqliteCache(db),
    spendCapUsd: options.spendCapUsd,
  });

  const enrichedAt = new Date();
  for (const result of results) {
    const found = result.classification;
    // A dropped posting keeps its row — `posting_sources` hangs off it and the ghost pass
    // still needs it — but stores no classification. `track` stays NULL, and neither tab can
    // select a NULL track, so a senior or off-track posting is unreachable from the UI.
    db.update(postings)
      .set({
        enrichedAt,
        descriptionHash: result.contentHash,
        track: found?.track ?? null,
        seniority: found?.seniority ?? null,
        employmentType: found?.employment_type ?? null,
        internshipSeason: found?.internship_season ?? null,
        paid: found?.paid ?? null,
        workMode: found?.work_mode ?? null,
        location: found?.location ?? null,
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
      .where(eq(postings.id, result.id))
      .run();
  }

  return stats;
}

export function formatStats(stats: EnrichStats, spendCapUsd: number): string {
  const line = [
    `enrich: ${stats.processed} processed`,
    `${stats.stored} stored`,
    `${stats.dropped} dropped (${stats.prefilterDrops} by prefilter)`,
    `${stats.calls} calls`,
    `${stats.cacheHits} cache hits`,
    `est. cost $${stats.costUsd.toFixed(4)} of $${spendCapUsd.toFixed(2)} cap`,
  ].join(', ');
  if (!stats.capReached) return line;
  return `${line}\nenrich: spend cap reached, ${stats.remaining} postings left for the next run`;
}

async function main(): Promise<void> {
  const spendCapUsd = parseSpendCap(process.env.WORKY_SPEND_CAP_USD);
  const sqlite = new Database(process.env.WORKY_DB ?? 'worky.db');
  try {
    const stats = await runEnrich(drizzle(sqlite, { schema }), anthropicClassifier(), {
      spendCapUsd,
    });
    console.log(formatStats(stats, spendCapUsd));
  } finally {
    sqlite.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
