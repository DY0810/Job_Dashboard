import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

import type { Db } from './db/index.ts';
import { CLAIM_TIMEOUT_MS, claimRequest, pendingRequest, requestRefresh } from './refresh-queue.ts';

function memoryDb(): Db {
  const db = drizzle(new Database(':memory:')) as unknown as Db;
  migrate(db, { migrationsFolder: 'drizzle' });
  return db;
}
const T = Date.parse('2026-08-22T10:00:00Z');

describe('the refresh queue', () => {
  it('is empty until somebody asks', async () => {
    expect(await pendingRequest(memoryDb(), T)).toBeNull();
  });

  it('records who asked, and hands the laptop the request', async () => {
    const db = memoryDb();
    const { request, queued } = await requestRefresh(db, 'sam', T);
    expect(queued).toBe(true);
    expect(request).toMatchObject({ requestedBy: 'sam', claimedAt: null });

    const claimed = await claimRequest(db, T + 1000);
    expect(claimed).toMatchObject({ id: request.id, requestedBy: 'sam' });
    expect(claimed!.claimedAt!.getTime()).toBe(T + 1000);
  });

  it('collapses a queue of clicks into one cycle', async () => {
    const db = memoryDb();
    const first = await requestRefresh(db, 'sam', T);
    const second = await requestRefresh(db, 'dyl', T + 500);
    expect(second.queued).toBe(false);
    expect(second.request.id).toBe(first.request.id); // one cycle answers both
  });

  it('has nothing to claim once a cycle has taken it', async () => {
    const db = memoryDb();
    await requestRefresh(db, null, T);
    await claimRequest(db, T + 1000);
    expect(await claimRequest(db, T + 2000)).toBeNull();
    expect(await pendingRequest(db, T + 2000)).toBeNull();
  });

  it('a new ask after a claim is a new request', async () => {
    const db = memoryDb();
    const first = await requestRefresh(db, null, T);
    await claimRequest(db, T + 1000);
    const next = await requestRefresh(db, null, T + 2000);
    expect(next.queued).toBe(true);
    expect(next.request.id).not.toBe(first.request.id);
  });

  it('frees a request whose cycle died before finishing', async () => {
    const db = memoryDb();
    await requestRefresh(db, null, T);
    await claimRequest(db, T);
    // Nothing to do while the cycle could still be running…
    expect(await claimRequest(db, T + CLAIM_TIMEOUT_MS - 1000)).toBeNull();
    // …but a claim this old belongs to a cycle that is not coming back.
    expect(await claimRequest(db, T + CLAIM_TIMEOUT_MS + 1000)).not.toBeNull();
  });
});
