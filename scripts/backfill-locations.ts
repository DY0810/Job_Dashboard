/**
 * `npm run backfill:locations` — recompute the stored location columns from the `location`
 * string each posting already carries.
 *
 * WHY THIS EXISTS. `city_norm`, `state`, `country` and `is_remote` are written once, at
 * ingest, by whatever `normalizeLocation` looked like that day. Fixing the normalizer does
 * nothing for a row already in the table. That was tolerable while `GEO_TIER` only reordered
 * the Design tab; now it decides whether a row appears at all, and `GET /api/postings/<id>`
 * applies the same rule, so a stale row is both invisible in the table and a 404 on its own
 * deep link.
 *
 * "The next ingest will fix it" is not true for every row. A posting whose connector is
 * erroring, or whose company has left the registry, is never re-fetched — and `ghost.ts` will
 * not delist it either, because it only ages postings absent from *successful* polls.
 * SmartRecruiters is the live example: it is robots-blocked, so nothing it ever gave us will
 * be re-ingested by any run. Those rows stay wrong until something walks the table.
 *
 * WHAT IT DOES NOT DO — and this is deliberate.
 *
 * `dedupe_key` is left alone. It is the merge identity: rewriting it can split rows that are
 * currently merged and collide rows that are currently distinct, and the collisions are the
 * dangerous half, because `dedupe_key` is UNIQUE. `location_key` is left alone with it — it
 * is a `dedupe_key` component, and updating one without the other would leave a stored key
 * that no longer derives from its stored parts. Nothing reads `location_key` back out of the
 * database (dedupe recomputes it per batch), so leaving it stale is invisible; leaving it
 * *inconsistent* would not be.
 *
 * The consequence, stated plainly: where the old normalizer gave two spellings of one job two
 * different `city_norm` values, the two rows still exist and this pass does not merge them.
 * Nor will a re-ingest — `ingest.ts` keeps a row's existing `dedupe_key` when the corrected
 * one is already taken (its `keyTaken` guard), so the pair is permanent, not pending.
 * `duplicatePairs` below counts them so someone can decide whether a merge pass is worth
 * writing. Collapsing rows destroys data in a way recomputing a derived column does not, and
 * it needs its own safety argument.
 *
 *   npm run backfill:locations -- --dry-run    report only, write nothing
 *   npm run backfill:locations
 */

import { pathToFileURL } from 'node:url';

import { eq } from 'drizzle-orm';

import { dedupeKey } from '../lib/dedupe.ts';
import { GEO_TIER, geoTier } from '../lib/geo.ts';
import { openDb, type Db } from '../lib/db/index.ts';
import { normalizeLocation } from '../lib/normalize.ts';
import { postings } from '../lib/db/schema.ts';

/** Tier number back to its name, read off `GEO_TIER` so a new tier cannot go unlabelled. */
const TIER_NAME: Record<number, string> = Object.fromEntries(
  Object.entries(GEO_TIER)
    .filter(([, value]) => typeof value === 'number')
    .map(([name, value]) => [value, name]),
);

export interface BackfillStats {
  /** Postings with a `location` string to recompute from. */
  examined: number;
  /** Postings whose raw location string was never persisted — nothing to recompute from. */
  skipped: number;
  /** Of those, the ones whose stored columns disagreed with the recomputed ones. */
  changed: number;
  /** `"elsewhere -> metro"` and friends, counted. Only rows that actually moved tier. */
  moves: Record<string, number>;
  /** Rows leaving / entering the one tier the Design tab hides, and the Design-track subset. */
  shown: number;
  hidden: number;
  shownDesign: number;
  hiddenDesign: number;
  /**
   * Distinct jobs holding more than one posting row once every `dedupe_key` is recomputed
   * with today's normalizers — the duplicates the old ones created. Reported, never repaired.
   */
  duplicatePairs: number;
  duplicateRows: number;
}

export function runBackfill(db: Db, options: { dryRun?: boolean } = {}): BackfillStats {
  const stats: BackfillStats = {
    examined: 0,
    skipped: 0,
    changed: 0,
    moves: {},
    shown: 0,
    hidden: 0,
    shownDesign: 0,
    hiddenDesign: 0,
    duplicatePairs: 0,
    duplicateRows: 0,
  };

  const all = db
    .select({
      id: postings.id,
      company: postings.company,
      title: postings.title,
      location: postings.location,
      workMode: postings.workMode,
      track: postings.track,
      cityNorm: postings.cityNorm,
      state: postings.state,
      country: postings.country,
      isRemote: postings.isRemote,
    })
    .from(postings)
    .all();

  // Count the duplicates the old normalizer left behind, over EVERY row: a stale row can be
  // the twin of one that already normalized correctly.
  const byKey = new Map<string, number>();
  for (const row of all) {
    const key = dedupeKey(row.company, row.title, row.location);
    byKey.set(key, (byKey.get(key) ?? 0) + 1);
  }
  for (const count of byKey.values()) {
    if (count > 1) {
      stats.duplicatePairs += 1;
      stats.duplicateRows += count;
    }
  }

  const stale = all.filter((row) => row.location !== null);
  stats.examined = stale.length;
  stats.skipped = all.length - stale.length;

  db.transaction((tx) => {
    for (const row of stale) {
      const fresh = normalizeLocation(row.location);
      const stored = {
        city_norm: row.cityNorm,
        state: row.state,
        country: row.country,
        is_remote: row.isRemote,
      };
      if (
        stored.city_norm === fresh.city_norm &&
        stored.state === fresh.state &&
        stored.country === fresh.country &&
        stored.is_remote === fresh.is_remote
      ) {
        continue;
      }

      stats.changed += 1;
      const before = geoTier(stored, row.workMode);
      const after = geoTier(fresh, row.workMode);
      if (before !== after) {
        const move = `${TIER_NAME[before]} -> ${TIER_NAME[after]}`;
        stats.moves[move] = (stats.moves[move] ?? 0) + 1;
        const design = row.track === 'design';
        if (before === GEO_TIER.elsewhere) {
          stats.shown += 1;
          if (design) stats.shownDesign += 1;
        } else if (after === GEO_TIER.elsewhere) {
          stats.hidden += 1;
          if (design) stats.hiddenDesign += 1;
        }
      }

      if (options.dryRun) continue;
      tx.update(postings)
        .set({
          cityNorm: fresh.city_norm,
          state: fresh.state,
          country: fresh.country,
          isRemote: fresh.is_remote,
        })
        .where(eq(postings.id, row.id))
        .run();
    }
  });

  return stats;
}

export function formatStats(stats: BackfillStats, dryRun: boolean): string {
  const moves = Object.entries(stats.moves).sort((a, b) => b[1] - a[1]);
  return [
    dryRun ? 'DRY RUN — nothing written' : 'backfill complete',
    `examined  ${stats.examined} postings with a location string (${stats.skipped} have none)`,
    `changed   ${stats.changed}`,
    `visible   +${stats.shown} shown on Design (${stats.shownDesign} design-track) · ` +
      `-${stats.hidden} hidden (${stats.hiddenDesign} design-track)`,
    ...(moves.length > 0
      ? ['tier moves', ...moves.map(([move, count]) => `  ${String(count).padStart(5)}  ${move}`)]
      : ['tier moves  none']),
    `duplicates  ${stats.duplicateRows} rows in ${stats.duplicatePairs} groups share a ` +
      `recomputed dedupe_key — NOT merged by this pass, and not by a re-ingest either`,
  ].join('\n');
}

export function main(argv: string[] = process.argv.slice(2)): void {
  const dryRun = argv.includes('--dry-run');
  console.log(formatStats(runBackfill(openDb(), { dryRun }), dryRun));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
