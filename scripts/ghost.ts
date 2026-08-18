/**
 * The ghost pass (plan Phase 10, finding C) — decide which postings have quietly died.
 *
 * `lib/dedupe.ts` holds the rule (`nextAbsenceCount`, `isGhost`); this runs it against the
 * database once per ingest. It owns `posting_sources.absence_count` outright — nothing else
 * writes that column — so the whole delisting rule is readable in one file.
 *
 * THE PROPERTY THAT MATTERS. A posting is aged toward delisting only by a source that
 * ANSWERED COMPLETELY this run. Not a connector that errored, not one skipped for its minimum
 * interval, not one skipped for a missing API key — and not one that returned a partial
 * catalogue, which is the case the connector-level `ok` status alone does not catch. Getting
 * this wrong wipes a source's inventory after one bad afternoon, and the damage is invisible:
 * a delisted posting looks exactly like a company that stopped hiring. That is why the caller
 * passes the eligible connectors explicitly rather than this file inferring them from status.
 *
 * Per-connector cadence made the second hazard live. Before it, every connector ran every
 * cycle, so "not eligible" only ever meant failure. Now a source polled every six hours sits
 * out eleven cycles in twelve, and counting those would delist its whole catalogue within the
 * hour. The `IN (eligible connectors)` clause on the UPDATE is what stops it.
 */

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { GHOST_ABSENCE_THRESHOLD } from '../lib/dedupe.ts';
import type { Db } from '../lib/db/index.ts';
import { postings, postingSources } from '../lib/db/schema.ts';

export interface GhostOptions {
  /** The run whose sightings count as "seen"; matched against `posting_sources.last_seen_run`. */
  runId: string;
  /**
   * Connector names entitled to age their own postings this run. NOT the connectors that were
   * selected, or attempted, or that merely returned `ok` — see `ghostEligible` in `ingest.ts`.
   */
  okConnectors: string[];
  now?: Date;
}

export interface GhostStats {
  /** Source rows belonging to an eligible connector — the only rows we may judge. */
  polled: number;
  /** Of those, the ones their source did not list this run. */
  absent: number;
  delisted: number;
  restored: number;
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
    // sources eligible this run — the load-bearing clause in this file.
    tx.update(postingSources)
      .set({
        absenceCount: sql`case when ${postingSources.lastSeenRun} = ${options.runId} then 0 else ${postingSources.absenceCount} + 1 end`,
      })
      .where(mine)
      .run();

    /**
     * `isGhost` from `lib/dedupe.ts`, as SQL, so the whole corpus is one statement rather than
     * 5,000 round trips. `MIN(absence_count) >= threshold` is `sources.every(...)`, and
     * `GROUP BY` only yields a row for a posting that HAS sources, which is `length > 0`.
     * `ghost.test.ts` asserts the two spellings answer the same thing.
     *
     * ponytail: `min()` spans every source row, including sources whose connector no longer
     * runs at all — an expired key, a host that started refusing robots, a connector dropped
     * from the list. Such a source freezes below the threshold and its postings become
     * undelistable here. That errs the safe way (a dead job stays visible rather than a live
     * one vanishing) and `linkcheck` marks those links weekly regardless. If it ever needs
     * fixing, exclude sources whose connector has no `ok` run inside some window.
     */
    const isGhostNow = sql`${postings.id} in (select ${postingSources.postingId} from ${postingSources}
      group by ${postingSources.postingId} having min(${postingSources.absenceCount}) >= ${GHOST_ABSENCE_THRESHOLD})`;

    stats.delisted = tx
      .update(postings)
      .set({ delistedAt: now, delistedReason: 'ghost' })
      .where(and(isNull(postings.delistedAt), isGhostNow))
      .run().changes;

    // A reappearance clears only what THIS pass delisted. `linkcheck` marks postings whose
    // sources still list them — absence counts of zero — so "no longer a ghost" is true of
    // them from the moment they are marked, and without the reason column this statement
    // would undo every weekly link check within half an hour.
    stats.restored = tx
      .update(postings)
      .set({ delistedAt: null, delistedReason: null })
      .where(and(eq(postings.delistedReason, 'ghost'), sql`not (${isGhostNow})`))
      .run().changes;
  });

  return stats;
}

export function formatGhostStats(stats: GhostStats): string {
  return `ghost: ${stats.polled} sources polled, ${stats.absent} absent, ${stats.delisted} delisted, ${stats.restored} restored`;
}
