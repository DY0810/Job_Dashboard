/**
 * `npm run merge:duplicates` — collapse posting rows that are the same job.
 *
 * WHAT COUNTS AS THE SAME JOB, and why it is this and not something fuzzier: `dedupe_key` is
 * `sha256(company_norm ␟ title_norm ␟ location_key)`, so two rows agreeing on all three
 * columns ARE one job by the corpus's own definition. That is the whole rule. It needs no
 * threshold, no title-similarity ratio and no judgement, which is what makes a destructive
 * pass defensible.
 *
 * They can exist at all because `dedupe_key` is computed from RAW strings at ingest, under
 * whichever normalizers were current that day. Two rows written weeks apart can therefore
 * carry different stored keys while their stored components now agree — and `ingest.ts` will
 * never heal it, because its `keyTaken` guard makes a row keep its existing key when the
 * corrected one is taken. The pair is permanent, not pending.
 *
 * Deliberately NOT merged here: the same job in two different cities. Sierra's "Enterprise
 * Sales Engineer" in San Francisco and in Sydney share a company and a title and nothing else,
 * and `location_key` is a `dedupe_key` component precisely so they stay two rows. A pass that
 * merged those would delete real openings.
 *
 * WHO SURVIVES, in order: a live row over a delisted one, then the most sources, then the
 * longest description, then the lowest id. The first rule is the one that matters — a delisted
 * row is already invisible, so keeping the live row means the merge cannot change what the UI
 * shows except by removing a genuine double-listing.
 *
 *   npm run merge:duplicates -- --dry-run    report only, write nothing
 *   npm run merge:duplicates
 */

import { pathToFileURL } from 'node:url';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { openDb, type Db } from '../lib/db/index.ts';
import { postings, postingSources } from '../lib/db/schema.ts';

interface Row {
  id: number;
  company: string;
  title: string;
  companyNorm: string;
  titleNorm: string;
  locationKey: string;
  delistedAt: Date | null;
  enrichedAt: Date | null;
  postedAt: Date;
  description: string | null;
  sourceFields: unknown;
  sources: number;
  descriptionLength: number;
}

export interface MergeStats {
  /** Groups of rows that are one job by `dedupe_key`'s own definition. */
  groups: number;
  /** Rows deleted — every row in every group except its survivor. */
  merged: number;
  /** Groups where more than one row was live, i.e. the ones the UI was double-listing. */
  visibleGroups: number;
  /** `posting_sources` rows moved onto a survivor. */
  sourcesMoved: number;
  /** Source rows dropped because the survivor already had that exact URL. */
  sourcesAlreadyHeld: number;
  /** Survivors that took a field from a row being deleted rather than losing it. */
  fieldsRecovered: number;
  /** One line per group, for the report. */
  lines: string[];
}

/**
 * Ordered worst-to-best, so `sort().at(-1)` is the survivor. Live-over-delisted first: it is
 * what keeps this pass from changing the tables in any way other than removing a double.
 */
function score(row: Row): [number, number, number, number] {
  return [
    row.delistedAt === null ? 1 : 0,
    row.sources,
    row.descriptionLength,
    -row.id,
  ];
}

function better(a: Row, b: Row): number {
  const [x, y] = [score(a), score(b)];
  for (let i = 0; i < x.length; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export function findDuplicateGroups(db: Db): Row[][] {
  const rows: Row[] = db
    .select({
      id: postings.id,
      company: postings.company,
      title: postings.title,
      companyNorm: postings.companyNorm,
      titleNorm: postings.titleNorm,
      locationKey: postings.locationKey,
      delistedAt: postings.delistedAt,
      enrichedAt: postings.enrichedAt,
      postedAt: postings.postedAt,
      description: postings.description,
      sourceFields: postings.sourceFields,
      sources: sql<number>`(select count(*) from ${postingSources} where ${postingSources.postingId} = ${postings.id})`,
      descriptionLength: sql<number>`length(coalesce(${postings.description}, ''))`,
    })
    .from(postings)
    .all() as Row[];

  const groups = new Map<string, Row[]>();
  for (const row of rows) {
    // The three `dedupe_key` components, joined with the same unit separator `dedupe.ts` uses
    // so this grouping and that hash cannot disagree about what a component boundary is.
    const key = [row.companyNorm, row.titleNorm, row.locationKey].join('␟');
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }

  return [...groups.values()].filter((group) => group.length > 1);
}

export function runMerge(db: Db, options: { dryRun?: boolean } = {}): MergeStats {
  const stats: MergeStats = {
    groups: 0,
    merged: 0,
    visibleGroups: 0,
    sourcesMoved: 0,
    sourcesAlreadyHeld: 0,
    fieldsRecovered: 0,
    lines: [],
  };

  for (const group of findDuplicateGroups(db)) {
    const ranked = [...group].sort(better);
    const survivor = ranked[ranked.length - 1];
    const losers = ranked.slice(0, -1);
    const live = group.filter((row) => row.delistedAt === null).length;

    stats.groups += 1;
    stats.merged += losers.length;
    if (live > 1) stats.visibleGroups += 1;
    stats.lines.push(
      `  ${live > 1 ? 'BOTH LIVE' : 'one live '}  keep ${String(survivor.id).padStart(6)} ` +
        `drop ${losers.map((row) => row.id).join(',').padEnd(12)} ` +
        `${survivor.company.slice(0, 16).padEnd(16)} ${survivor.title.slice(0, 34)}`,
    );

    if (options.dryRun) continue;

    db.transaction((tx) => {
      const held = new Set(
        tx
          .select({ url: postingSources.sourceUrl })
          .from(postingSources)
          .where(eq(postingSources.postingId, survivor.id))
          .all()
          .map((row) => row.url),
      );

      for (const loser of losers) {
        const moving = tx
          .select({ id: postingSources.id, url: postingSources.sourceUrl })
          .from(postingSources)
          .where(eq(postingSources.postingId, loser.id))
          .all();

        for (const source of moving) {
          // The unique index is (posting_id, source_url): re-pointing a URL the survivor
          // already holds would throw, and the row is redundant anyway — the cascade takes it.
          if (held.has(source.url)) {
            stats.sourcesAlreadyHeld += 1;
            continue;
          }
          held.add(source.url);
          stats.sourcesMoved += 1;
          tx
            .update(postingSources)
            .set({ postingId: survivor.id })
            .where(eq(postingSources.id, source.id))
            .run();
        }
      }

      /**
       * Take anything the survivor lacks from the rows about to be deleted, rather than
       * letting a merge lose data. `posted_at` floors at the earliest date any copy was seen,
       * which is the same direction `ingest.ts` moves it and for the same reason: the first
       * sighting is the true one, and a later copy must not age the job backwards.
       */
      const recovered: Record<string, unknown> = {};
      const earliest = Math.min(...group.map((row) => row.postedAt.getTime()));
      if (earliest < survivor.postedAt.getTime()) recovered.postedAt = new Date(earliest);
      if (!survivor.description) {
        const description = losers.find((row) => row.description)?.description;
        if (description) recovered.description = description;
      }
      if (survivor.sourceFields === null) {
        const fields = losers.find((row) => row.sourceFields !== null)?.sourceFields;
        if (fields !== undefined) recovered.sourceFields = fields;
      }
      if (survivor.enrichedAt === null) {
        const enriched = losers.find((row) => row.enrichedAt !== null)?.enrichedAt;
        if (enriched) recovered.enrichedAt = enriched;
      }
      if (Object.keys(recovered).length > 0) {
        stats.fieldsRecovered += Object.keys(recovered).length;
        tx.update(postings).set(recovered).where(eq(postings.id, survivor.id)).run();
      }

      // Sources were re-pointed above, so nothing here is still referenced. Deleting them
      // explicitly rather than trusting ON DELETE CASCADE, because `pragma foreign_keys` is
      // off by default on a fresh better-sqlite3 connection and a silent orphan is worse than
      // a loud one.
      const ids = losers.map((row) => row.id);
      tx.delete(postingSources).where(inArray(postingSources.postingId, ids)).run();
      tx.delete(postings).where(inArray(postings.id, ids)).run();
    });
  }

  return stats;
}

/** Rows left with no source at all — the one way this pass could corrupt the corpus. */
export function orphanedPostings(db: Db): number {
  return (
    db
      .select({ id: postings.id })
      .from(postings)
      .where(
        and(
          isNull(postings.delistedAt),
          sql`not exists (select 1 from ${postingSources} where ${postingSources.postingId} = ${postings.id})`,
        ),
      )
      .all().length
  );
}

export function formatStats(stats: MergeStats, dryRun: boolean): string {
  return [
    dryRun ? 'DRY RUN — nothing written' : 'merge complete',
    `groups    ${stats.groups} sets of rows are one job by dedupe_key's own three components`,
    `merged    ${stats.merged} rows removed`,
    `visible   ${stats.visibleGroups} of those groups had more than one LIVE row — the doubles a reader could see`,
    ...(dryRun
      ? []
      : [
          `sources   ${stats.sourcesMoved} moved to a survivor, ${stats.sourcesAlreadyHeld} dropped as already held`,
          `recovered ${stats.fieldsRecovered} fields taken from a deleted row rather than lost`,
        ]),
    ...(stats.lines.length > 0 ? ['', ...stats.lines] : []),
  ].join('\n');
}

function main(): void {
  const dryRun = process.argv.includes('--dry-run');
  const db = openDb();
  const before = orphanedPostings(db);
  console.log(formatStats(runMerge(db, { dryRun }), dryRun));
  const after = orphanedPostings(db);
  if (after !== before) {
    console.error(`\nFAILED: live postings with no source went ${before} -> ${after}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nlive postings with no source: ${after} (unchanged)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
