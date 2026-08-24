/**
 * The refresh queue: how a visitor on the hosted site asks the laptop to poll the sources.
 *
 * The pipeline — 18 connectors, enrich, ghost detection — runs where `workie.db` is, through
 * the synchronous driver, and takes minutes. Nothing on Vercel can run it. So the hosted
 * button writes a row here and the laptop claims it, which needs no inbound networking and
 * no tunnel; the cost is that the laptop must be awake to notice.
 *
 * One unclaimed row is the whole queue. Three people clicking during one cycle is one
 * request, because one cycle answers all three.
 */

import { and, desc, eq, isNull, lt } from 'drizzle-orm';

import { driver, type ReadDb } from './db/index.ts';
import { refreshRequests } from './db/schema.ts';

export type RefreshRequest = typeof refreshRequests.$inferSelect;

/** A claim older than this was taken by a cycle that died; the request is free again. */
export const CLAIM_TIMEOUT_MS = 20 * 60 * 1000;

/** The oldest request nobody is acting on, including one whose claimer went away. */
export async function pendingRequest(db: ReadDb, now: number = Date.now()): Promise<RefreshRequest | null> {
  const rows = await driver(db)
    .select()
    .from(refreshRequests)
    .where(isNull(refreshRequests.claimedAt))
    .orderBy(refreshRequests.requestedAt)
    .limit(1)
    .all();
  if (rows[0]) return rows[0];
  const stale = await driver(db)
    .select()
    .from(refreshRequests)
    .where(lt(refreshRequests.claimedAt, new Date(now - CLAIM_TIMEOUT_MS)))
    .orderBy(desc(refreshRequests.requestedAt))
    .limit(1)
    .all();
  return stale[0] ?? null;
}

/**
 * Ask for a refresh. Returns the request that will serve the asker — an existing unclaimed
 * one when there is one, so a queue of clicks collapses to a single cycle.
 */
export async function requestRefresh(
  db: ReadDb,
  by: string | null = null,
  now: number = Date.now(),
): Promise<{ request: RefreshRequest; queued: boolean }> {
  const waiting = await pendingRequest(db, now);
  if (waiting && waiting.claimedAt === null) return { request: waiting, queued: false };
  const rows = await driver(db)
    .insert(refreshRequests)
    .values({ requestedBy: by, requestedAt: new Date(now) })
    .returning()
    .all();
  return { request: rows[0]!, queued: true };
}

/**
 * Take the pending request, if there is one. Returns null when there is nothing to do, which
 * is what the laptop's poller sees on almost every tick.
 */
export async function claimRequest(db: ReadDb, now: number = Date.now()): Promise<RefreshRequest | null> {
  const waiting = await pendingRequest(db, now);
  if (!waiting) return null;
  // `eq(col, null)` compiles to `col = NULL`, which is never true — the guard has to be
  // `IS NULL` for the common case, or the claim silently updates nothing.
  const unchanged =
    waiting.claimedAt === null
      ? isNull(refreshRequests.claimedAt)
      : eq(refreshRequests.claimedAt, waiting.claimedAt);
  const rows = await driver(db)
    .update(refreshRequests)
    .set({ claimedAt: new Date(now) })
    .where(and(eq(refreshRequests.id, waiting.id), unchanged))
    .returning()
    .all();
  // Empty means another poller claimed it between the read and the write; not ours to run.
  return rows[0] ?? null;
}
