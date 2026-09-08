import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openDb, type Db } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import { fixtures } from './seed.ts';
import { ensureCachedState, pullRemote } from './pull-remote.ts';

it('publishes a complete cold bootstrap and refuses to overwrite it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workie-bootstrap-'));
  try {
    const source = join(dir, 'source.db');
    const target = join(dir, 'restored.db');
    const db = openDb(source, { migrate: true }) as Db & { $client: Database.Database };
    db.insert(postings).values(fixtures(Date.now())).run();
    const expected = db.select({ id: postings.id }).from(postings).all().length;
    db.$client.close();
    const counts = await pullRemote(`file:${source}`, undefined, target);
    expect(counts[0].rows).toBe(expected);
    expect(existsSync(target)).toBe(true);
    await expect(pullRemote(`file:${source}`, undefined, target)).rejects.toThrow('already exists');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('never publishes a partial bootstrap when a later table fails', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workie-bootstrap-failure-'));
  try {
    const source = join(dir, 'source.db');
    const target = join(dir, 'restored.db');
    const db = openDb(source, { migrate: true }) as Db & { $client: Database.Database };
    db.insert(postings).values(fixtures(Date.now())).run();
    db.run(sql`drop table connector_runs`);
    db.$client.close();
    await expect(pullRemote(`file:${source}`, undefined, target)).rejects.toThrow();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(`${target}.bootstrap-${process.pid}`)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('recovers a cache behind the mirror without overwriting an ahead-of-mirror cache', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workie-cache-generation-'));
  try {
    const source = join(dir, 'source.db');
    const cache = join(dir, 'cache.db');
    const db = openDb(source, { migrate: true }) as Db & { $client: Database.Database };
    db.insert(postings).values(fixtures(Date.now())).run();
    await db.$client.backup(cache);
    db.$client.close();
    const old = openDb(cache) as Db & { $client: Database.Database };
    old.run(sql`delete from postings where id = (select max(id) from postings)`);
    old.$client.close();
    expect(await ensureCachedState(`file:${source}`, undefined, cache)).toBe(true);
    expect(existsSync(`${cache}.stale-${process.pid}`)).toBe(true);

    const current = openDb(cache) as Db & { $client: Database.Database };
    current.insert(postings).values({ ...fixtures(Date.now())[0], id: 99_999, dedupeKey: 'ahead' }).run();
    current.$client.close();
    expect(await ensureCachedState(`file:${source}`, undefined, cache)).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
