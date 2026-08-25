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
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { fixtures } from '../../scripts/seed.ts';
import { pushRemote } from '../../scripts/push-remote.ts';
import {
  DEFAULT_BASIS, bare, type Params, type Tab
} from '../params.ts';
import { getPostingDetail, listPostings, outsideTargetLocations, tabIsEmpty } from '../query.ts';
import { needsTurso, openDb, prefersTurso, type Db, type ReadDb, type TursoDb } from './index.ts';
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
  it('is idempotent, and a second run writes NOTHING rather than rewriting every row', async () => {
    const target = `file:${join(dir, 'remote.db')}`;
    const before = await listPostings(remote, params('design'), NOW);

    // Whatever the first pass has to do, the second must find nothing to say. The old
    // behaviour re-upserted the entire corpus every time; against Turso that billed ~53,000
    // row writes a cycle and eventually returned `BLOCKED: SQL write operations are
    // forbidden`, which stopped the dashboard updating at all. Asserting ZERO here is what
    // keeps that from creeping back.
    await pushRemote(target, undefined);
    const second = await pushRemote(target, undefined);

    expect(second.map((count) => count.rows)).toEqual([0, 0, 0]);
    // Nothing was deleted: the local corpus is the same one already up there.
    expect(second.map((count) => count.deleted)).toEqual([0, 0, 0]);
    // And writing nothing must not mean serving nothing.
    expect(await listPostings(remote, params('design'), NOW)).toEqual(before);
  });

  it('still pushes a row after it changes locally', async () => {
    const target = `file:${join(dir, 'remote.db')}`;
    await pushRemote(target, undefined);
    expect((await pushRemote(target, undefined))[0].rows).toBe(0);

    // Ids are assigned on insert, so ask the corpus rather than the fixture literals.
    const local = openDb();
    const id = local.select({ id: postings.id }).from(postings).limit(1).all()[0]!.id;
    local.update(postings).set({ title: 'Retitled By Test' }).where(eq(postings.id, id)).run();

    expect((await pushRemote(target, undefined))[0].rows).toBe(1);
    expect((await getPostingDetail(remote, id, NOW))?.title).toBe('Retitled By Test');
  });

  /**
   * The pass that `merge:duplicates` made necessary. An upsert cannot express a deletion, so
   * a row the local corpus has merged away used to stay up there and keep being served — and
   * worse, it kept holding a `dedupe_key` the surviving row would later claim, which fails the
   * UNIQUE index on the way in.
   */
  it('deletes a remote row the local corpus no longer has', async () => {
    const stray = { ...fixtures(NOW)[0], id: 99_001, dedupeKey: 'stray-key', canonicalUrl: 'https://stray.test' };
    await (remote as unknown as TursoDb).insert(postings).values(stray);
    expect(await getPostingDetail(remote, 99_001, NOW)).not.toBeNull();

    const counts = await pushRemote(`file:${join(dir, 'remote.db')}`, undefined);

    expect(counts[0].deleted).toBe(1);
    expect(await getPostingDetail(remote, 99_001, NOW)).toBeNull();
  });
});

describe('an unconfigured deploy', () => {
  it('is a state to render, not a crash — and only where there is no local file', () => {
    expect(needsTurso({ VERCEL: '1' }), 'hosted, no Turso yet').toBe(true);
    expect(needsTurso({ VERCEL: '1', TURSO_DATABASE_URL: 'libsql://x' })).toBe(false);
    expect(needsTurso({}), 'a local checkout reads workie.db').toBe(false);
  });
});

// ---------------------------------------------------------------------------------------
// Driver selection. The regression this pins: the wizard writes TURSO_DATABASE_URL into
// .env.local so `push:remote` can read it — and Next.js loads that same file for the app,
// so a machine with a perfectly good workie.db on disk silently switched every page load
// to the network. Measured: 1-2ms warm queries became 52-60ms, and 1.1s cold.
// Presence of a credential is not intent to use it; deployment context is.
// ---------------------------------------------------------------------------------------

describe('prefersTurso', () => {
  const TURSO = { TURSO_DATABASE_URL: 'libsql://x.turso.io', TURSO_AUTH_TOKEN: 't' };

  it('never chooses turso without a URL', () => {
    expect(prefersTurso({}, true)).toBe(false);
    expect(prefersTurso({}, false)).toBe(false);
  });

  it('chooses turso on Vercel, where no local file can exist', () => {
    expect(prefersTurso({ ...TURSO, VERCEL: '1' }, false)).toBe(true);
  });

  it('prefers the local file when one exists, even with credentials present', () => {
    // The bug: credentials in .env.local made the local dev server query the
    // hosted replica while workie.db sat on disk, 25-50x faster.
    expect(prefersTurso(TURSO, true)).toBe(false);
  });

  it('falls back to turso on a machine with credentials but no local database', () => {
    expect(prefersTurso(TURSO, false)).toBe(true);
  });

  it('WORKIE_DB_DRIVER=turso is an explicit override for remote previews', () => {
    expect(prefersTurso({ ...TURSO, WORKIE_DB_DRIVER: 'turso' }, true)).toBe(true);
  });
});
