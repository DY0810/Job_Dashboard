/**
 * The hosted path, end to end: mirror the local file into a libSQL database, then read it
 * back through `lib/query.ts`.
 *
 * The whole design rests on one claim — that awaiting a synchronous driver and awaiting an
 * asynchronous one give the same answers, so the read path needs no branch. Nothing else
 * checks it: `query.test.ts` runs against better-sqlite3 only, and a driver difference would
 * surface as an empty table on the deployed site rather than as a failing test. So this runs
 * the same four functions against the async driver and demands identical output.
 *
 * A `file:` URL needs no Turso account, which is also how `push:remote` is rehearsed.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixtures } from '../../scripts/seed.ts';
import { pushRemote } from '../../scripts/push-remote.ts';
import {
  DEFAULT_BASIS, bare, type Params, type Tab
} from '../params.ts';
import { getPostingDetail, listPostings, outsideTargetLocations, tabIsEmpty } from '../query.ts';
import { needsTurso, openDb, type Db, type ReadDb } from './index.ts';
import * as schema from './schema.ts';
import { postings } from './schema.ts';

const NOW = Date.UTC(2026, 2, 17, 12, 0, 0);

let dir: string;
let local: Db;
let remote: ReadDb;

function params(tab: Tab, over: Partial<Params> = {}): Params {
  return {
    tab,
    // Faithful to `parseParams`: Design always lands on a side of the freelance split,
    // Engineering has no split at all.
    basis: tab === 'design' ? DEFAULT_BASIS : null,
    posted: null,
    type: [],
    pay: [],
    mode: [],
    season: [],
    level: [],
    badge: null,
    job: null,
    ...over,
  };
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workie-turso-'));
  const localPath = join(dir, 'local.db');
  local = openDb(localPath, { migrate: true });
  local.insert(postings).values(fixtures(NOW)).run();

  // `pushRemote` reads whatever `openDb()` opens, and migrates the target itself — the
  // remote file below does not exist yet, which is the case a first deploy is in.
  process.env.WORKIE_DB = localPath;
  await pushRemote(`file:${join(dir, 'remote.db')}`, undefined);
  remote = drizzle(createClient({ url: `file:${join(dir, 'remote.db')}` }), { schema });
});

afterAll(() => {
  delete process.env.WORKIE_DB;
  rmSync(dir, { recursive: true, force: true });
});

describe('the read path gives the same answers on either driver', () => {
  it.each(['design', 'engineering'] as const)('%s: the same rows in the same order', async (tab) => {
    const rows = await listPostings(remote, params(tab), NOW);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows).toEqual(await listPostings(local, params(tab), NOW));
  });

  it('the same rows under a filter, and the same empty result', async () => {
    const p = params('engineering', { mode: ['remote'], type: ['internship'] });
    expect(await listPostings(remote, p, NOW)).toEqual(await listPostings(local, p, NOW));

    const none = params('design', { type: ['part-time'], mode: ['remote'] });
    expect(await listPostings(remote, none, NOW)).toEqual([]);
    expect(await tabIsEmpty(remote, none, NOW)).toBe(false);
  });

  it('the same detail row, and the same null for one the rules hide', async () => {
    const visible = (await listPostings(remote, params('design'), NOW))[0];
    expect(await getPostingDetail(remote, visible.id, NOW)).toEqual(
      await getPostingDetail(local, visible.id, NOW),
    );
    expect(await getPostingDetail(remote, 999_999, NOW)).toBeNull();
  });

  it('the same count of what geography hides', async () => {
    const p = bare(params('design'));
    expect(await outsideTargetLocations(remote, p, NOW)).toBe(
      await outsideTargetLocations(local, p, NOW),
    );
    expect(await outsideTargetLocations(remote, p, NOW)).toBeGreaterThan(0);
  });
});

describe('push:remote', () => {
  it('is idempotent: a second run rewrites the same rows rather than duplicating them', async () => {
    const before = await listPostings(remote, params('design'), NOW);
    const counts = await pushRemote(`file:${join(dir, 'remote.db')}`, undefined);

    expect(counts[0]).toBe(fixtures(NOW).length);
    expect(await listPostings(remote, params('design'), NOW)).toEqual(before);
  });
});

describe('an unconfigured deploy', () => {
  it('is a state to render, not a crash — and only where there is no local file', () => {
    expect(needsTurso({ VERCEL: '1' }), 'hosted, no Turso yet').toBe(true);
    expect(needsTurso({ VERCEL: '1', TURSO_DATABASE_URL: 'libsql://x' })).toBe(false);
    expect(needsTurso({}), 'a local checkout reads workie.db').toBe(false);
  });
});
