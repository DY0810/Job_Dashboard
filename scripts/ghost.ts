/**
 * The ghost pass (plan Phase 10, finding C) — decide which postings have quietly died.
 *
 * `lib/dedupe.ts` holds the rule (`nextAbsenceCount`, `isGhost`); this runs it against the
 * database once per ingest. It owns `posting_sources.absence_count` outright — nothing else
 * writes that column — so the whole delisting rule is readable in one file.
 *
 * THE PROPERTY THAT MATTERS. An absence counts only when that source's `connector_runs` row
 * for THIS run is `ok`. Everything else — a connector that 500d, a connector skipped for its
 * minimum interval, a connector skipped for a missing API key — leaves its rows untouched.
 * Getting this wrong wipes a source's whole inventory after one bad afternoon, and the damage
 * is invisible: a delisted posting looks exactly like a company that stopped hiring. That is
 * why the caller passes the `ok` connectors explicitly rather than this file inferring them.
 *
 * Per-connector cadence made the second hazard live. Before it, every connector ran every
 * cycle, so "not in the ok list" only ever meant failure. Now a source polled every six hours
 * sits out eleven cycles in twelve, and counting those would delist its whole catalogue
 * within the hour. The `IN (ok connectors)` clause on the UPDATE is what stops it.
 */

import { and, inArray, isNull, isNotNull, sql } from 'drizzle-orm';

import { GHOST_ABSENCE_THRESHOLD } from '../lib/dedupe.ts';
import type { Db } from '../lib/db/index.ts';
import { postings, postingSources } from '../lib/db/schema.ts';

export interface GhostOptions {
  /** The run whose sightings count as "seen"; matched against `posting_sources.last_seen_run`. */
  runId: string;
  /**
   * Connector names whose `connector_runs` row for this run is `ok`. NOT the connectors that
   * were selected, or attempted, or configured — only the ones that actually answered.
   */
  okConnectors: string[];
  /**
   * Postings that were already ghosts before this run's postings were written, from
   * `ghostPostingIds()`. See that function for why the caller has to take the snapshot.
   */
  wasGhost: ReadonlySet<number>;
  now?: Date;
}

export interface GhostStats {
  /** Source rows belonging to an `ok` connector this run — the only rows we may judge. */
  polled: number;
  /** Of those, the ones their source did not list this run. */
  absent: number;
  delisted: number;
  restored: number;
}

/**
 * Postings every one of whose sources has gone quiet — `isGhost`, as SQL, so the whole corpus
 * is one statement rather than 5,000 round trips. `MIN(absence_count) >= threshold` is
 * `sources.every(...)`, and `GROUP BY` only yields a row for a posting that HAS sources, which
 * is `sources.length > 0`. `ghost.test.ts` asserts the two agree.
 *
 * **Call this BEFORE the run's postings are persisted.** It is the only thing separating a
 * posting this pass killed from one `linkcheck` killed, and the two must not be confused:
 *
 *   - A posting `linkcheck` delisted has absence counts of zero — its sources still list it,
 *     the apply URL just serves a gone page. It is not in this snapshot, so the restore below
 *     skips it, and `linkcheck`'s verdict survives the 48 ingests a day that follow it.
 *   - A posting THIS pass delisted has every count at or past the threshold, so it is in the
 *     snapshot and a genuine reappearance restores it.
 *
 * Taken after persisting instead, a posting that reappears would already have been reset to
 * zero (or gained a fresh source row at zero) and would drop out of the snapshot — leaving it
 * delisted forever while a live source keeps listing it. Same invisible failure, other sign.
 */
export function ghostPostingIds(db: Db): Set<number> {
  const rows = db
    .select({ id: postingSources.postingId })
    .from(postingSources)
    .groupBy(postingSources.postingId)
    .having(sql`min(${postingSources.absenceCount}) >= ${GHOST_ABSENCE_THRESHOLD}`)
    .all();
  return new Set(rows.map((row) => row.id));
}

export function runGhostPass(db: Db, options: GhostOptions): GhostStats {
  const stats: GhostStats = { polled: 0, absent: 0, delisted: 0, restored: 0 };
  if (options.okConnectors.length === 0) return stats;
  const now = options.now ?? new Date();

  db.transaction((tx) => {
    const mine = inArray(postingSources.source, options.okConnectors);

    const tally = tx
      .select({
        polled: sql<number>`count(*)`,
        absent: sql<number>`sum(${postingSources.lastSeenRun} != ${options.runId})`,
      })
      .from(postingSources)
      .where(mine)
      .get();
    stats.polled = tally?.polled ?? 0;
    stats.absent = tally?.absent ?? 0;

    // `nextAbsenceCount` as one statement: seen resets to 0, absent increments. Restricted to
    // sources whose connector returned `ok` this run — the load-bearing clause in this file.
    tx.update(postingSources)
      .set({
        absenceCount: sql`case when ${postingSources.lastSeenRun} = ${options.runId} then 0 else ${postingSources.absenceCount} + 1 end`,
      })
      .where(mine)
      .run();

    const isGhostNow = sql`${postings.id} in (select ${postingSources.postingId} from ${postingSources}
      group by ${postingSources.postingId} having min(${postingSources.absenceCount}) >= ${GHOST_ABSENCE_THRESHOLD})`;

    // Delisting needs no snapshot: `delisted_at is null` already excludes everything we (or
    // linkcheck) marked earlier, so this only ever fires on the transition into ghosthood.
    stats.delisted = tx
      .update(postings)
      .set({ delistedAt: now })
      .where(and(isNull(postings.delistedAt), isGhostNow))
      .run().changes;

    // Restoring does. Only a posting THIS pass had judged dead may be brought back — see
    // `ghostPostingIds`. ponytail: `inArray` binds one parameter per id against SQLite's
    // 32,766 limit; the corpus is ~5k postings, so a full-corpus restore fits six times over.
    // If it ever grows past that, chunk this list.
    if (options.wasGhost.size > 0) {
      stats.restored = tx
        .update(postings)
        .set({ delistedAt: null })
        .where(
          and(
            isNotNull(postings.delistedAt),
            inArray(postings.id, [...options.wasGhost]),
            sql`not (${isGhostNow})`,
          ),
        )
        .run().changes;
    }
  });

  return stats;
}

export function formatGhostStats(stats: GhostStats): string {
  return `ghost: ${stats.polled} sources polled, ${stats.absent} absent, ${stats.delisted} delisted, ${stats.restored} restored`;
}
