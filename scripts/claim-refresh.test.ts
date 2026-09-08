import { describe, expect, it } from 'vitest';
import { openDb } from '../lib/db/index.ts';
import { getRefreshRequest, requestRefresh } from '../lib/refresh-queue.ts';
import { claimAndRun, runRefreshCycles } from './claim-refresh.ts';

describe('cloud refresh completion', () => {
  it('finishes catch-up by advancing only pending connectors between mirrors', () => {
    let page = 0;
    const modes: boolean[] = [];
    const result = runRefreshCycles((pending) => {
      modes.push(pending);
      page += 1;
      return 0;
    }, () => new Map([['paged', { value: page, pending: page < 3 }]]), true);
    expect(result).toBe(0);
    expect(modes).toEqual([false, true, true]);
  });

  it('stops a stalled checkpoint and preserves a failed cycle status', () => {
    const pending = () => new Map([['paged', { value: 1, pending: true }]]);
    expect(runRefreshCycles(() => 0, pending, true)).toBe(1);
    expect(runRefreshCycles(() => 2, pending, true)).toBe(2);
  });

  it('signals an unfinished catch-up when its time budget expires', () => {
    let time = 0;
    const result = runRefreshCycles(() => { time += 76 * 60_000; return 0; },
      () => new Map([['paged', { value: 1, pending: true }]]), true, () => time);
    expect(result).toBe(75);
  });
  it.each([0, 1, 75])('returns cycle exit %i and records its outcome', async (code) => {
    const db = openDb(':memory:', { migrate: true });
    const { request } = await requestRefresh(db);
    expect(await claimAndRun(() => code, db)).toBe(code);
    const done = await getRefreshRequest(db, request.id);
    expect(done?.completedAt).toBeInstanceOf(Date);
    expect(done?.error).toBe(code === 0 ? null : `Refresh cycle exited with code ${code}`);
    expect(await claimAndRun(() => { throw new Error('must not rerun'); }, db)).toBeNull();
  });

  it('records a thrown runner failure and propagates it', async () => {
    const db = openDb(':memory:', { migrate: true });
    const { request } = await requestRefresh(db);
    await expect(claimAndRun(() => { throw new Error('spawn failed'); }, db)).rejects.toThrow('spawn failed');
    expect((await getRefreshRequest(db, request.id))?.error).not.toBeNull();
  });
});
