import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

import type { Db } from './db/index.ts';
import {
  CLAIM_TIMEOUT_MS, claimRequest, finishRequest, getRefreshRequest, pendingRequest, requestRefresh,
} from './refresh-queue.ts';

function memoryDb(): Db {
  const db = drizzle(new Database(':memory:')) as unknown as Db;
  migrate(db, { migrationsFolder: 'drizzle' });
  return db;
}
const T = Date.parse('2026-08-22T10:00:00Z');

describe('the refresh queue', () => {
  it('upgrades old queue rows without deleting them or pretending they succeeded', () => {
    const old = new Database(':memory:');
    old.exec(readFileSync('drizzle/0007_add_refresh_requests.sql', 'utf8'));
    old.prepare('insert into refresh_requests (requested_at, claimed_at) values (?, ?)').run(T, T + 1);
    old.prepare('insert into refresh_requests (requested_at) values (?)').run(T + 2);
    old.exec(readFileSync('drizzle/0008_refresh_completion.sql', 'utf8'));
    const rows = old.prepare('select completed_at, error from refresh_requests').all() as {
      completed_at: number | null; error: string | null;
    }[];
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.completed_at !== null && row.error !== null)).toBe(true);
    old.prepare('insert into refresh_requests (requested_at) values (?)').run(T + 3);
    expect(() => old.prepare('insert into refresh_requests (requested_at) values (?)').run(T + 4)).toThrow();
    old.close();
  });
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

  it('coalesces clicks while the runner is already working', async () => {
    const db = memoryDb();
    const first = await requestRefresh(db, null, T);
    await claimRequest(db, T + 1000);
    const next = await requestRefresh(db, null, T + 2000);
    expect(next.queued).toBe(false);
    expect(next.request.id).toBe(first.request.id);
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

  it('never reclaims a finished request, and permits a new request afterward', async () => {
    const db = memoryDb();
    const first = await requestRefresh(db, null, T);
    const claim = await claimRequest(db, T + 1000);
    await finishRequest(db, claim!, null, T + 2000);
    expect(await pendingRequest(db, T + CLAIM_TIMEOUT_MS * 2)).toBeNull();
    expect(await claimRequest(db, T + CLAIM_TIMEOUT_MS * 2)).toBeNull();
    expect(await getRefreshRequest(db, first.request.id)).toMatchObject({
      completedAt: new Date(T + 2000), error: null,
    });
    const next = await requestRefresh(db, null, T + 3000);
    expect(next.queued).toBe(true);
    expect(next.request.id).not.toBe(first.request.id);
  });

  it('records a failed cycle without claiming it succeeded or retrying it forever', async () => {
    const db = memoryDb();
    const { request } = await requestRefresh(db, null, T);
    const claim = await claimRequest(db, T + 1000);
    await finishRequest(db, claim!, 'Refresh cycle exited with code 1', T + 2000);
    expect(await getRefreshRequest(db, request.id)).toMatchObject({
      completedAt: new Date(T + 2000), error: 'Refresh cycle exited with code 1',
    });
    expect(await pendingRequest(db, T + CLAIM_TIMEOUT_MS * 2)).toBeNull();
  });

  it('does not let an expired claim complete a replacement runner request', async () => {
    const db = memoryDb();
    const { request } = await requestRefresh(db, null, T);
    const oldClaim = await claimRequest(db, T);
    await claimRequest(db, T + CLAIM_TIMEOUT_MS + 1);
    await finishRequest(db, oldClaim!, null, T + CLAIM_TIMEOUT_MS + 2);
    expect((await getRefreshRequest(db, request.id))?.completedAt).toBeNull();
  });

  it('keeps one active request under concurrent clicks', async () => {
    const db = memoryDb();
    const requests = await Promise.all(Array.from({ length: 8 }, () => requestRefresh(db, null, T)));
    expect(new Set(requests.map(({ request }) => request.id)).size).toBe(1);
    expect(requests.filter(({ queued }) => queued)).toHaveLength(1);
  });
});
