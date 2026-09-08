/** A durable request shared by Vercel and the sole GitHub Actions writer. */
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';

import { driver, type ReadDb } from './db/index.ts';
import { refreshRequests } from './db/schema.ts';

export type RefreshRequest = typeof refreshRequests.$inferSelect;

// Longer than the workflow's 120-minute budget, including its weekly link check.
export const CLAIM_TIMEOUT_MS = 130 * 60 * 1000;

export async function getRefreshRequest(db: ReadDb, id?: number): Promise<RefreshRequest | null> {
  return (await driver(db).select().from(refreshRequests)
    .where(id === undefined ? undefined : eq(refreshRequests.id, id))
    .orderBy(desc(refreshRequests.id)).limit(1).get()) ?? null;
}

/** The oldest request nobody is acting on, including one whose claimer went away. */
export async function pendingRequest(db: ReadDb, now: number = Date.now()): Promise<RefreshRequest | null> {
  const rows = await driver(db)
    .select()
    .from(refreshRequests)
    .where(and(
      isNull(refreshRequests.completedAt),
      or(isNull(refreshRequests.claimedAt), lt(refreshRequests.claimedAt, new Date(now - CLAIM_TIMEOUT_MS))),
    ))
    .orderBy(refreshRequests.requestedAt)
    .limit(1)
    .all();
  return rows[0] ?? null;
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
  // The partial unique index makes simultaneous visitors share one active request.
  const rows = await driver(db)
    .insert(refreshRequests)
    .values({ requestedBy: by, requestedAt: new Date(now) })
    .onConflictDoNothing()
    .returning()
    .all();
  if (rows[0]) return { request: rows[0], queued: true };
  const active = await driver(db).select().from(refreshRequests)
    .where(isNull(refreshRequests.completedAt)).limit(1).get();
  // A runner may finish between our INSERT and SELECT; retry against the constraint.
  if (!active) return requestRefresh(db, by, now);
  return { request: active, queued: false };
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
    .where(and(eq(refreshRequests.id, waiting.id), isNull(refreshRequests.completedAt), unchanged))
    .returning()
    .all();
  // Empty means another poller claimed it between the read and the write; not ours to run.
  return rows[0] ?? null;
}

export async function finishRequest(
  db: ReadDb,
  claim: RefreshRequest,
  error: string | null,
  now = Date.now(),
): Promise<void> {
  if (!claim.claimedAt) throw new Error('Cannot finish an unclaimed refresh');
  await driver(db).update(refreshRequests)
    .set({ completedAt: new Date(now), error })
    .where(and(
      eq(refreshRequests.id, claim.id),
      eq(refreshRequests.claimedAt, claim.claimedAt),
      isNull(refreshRequests.completedAt),
    )).run();
}
