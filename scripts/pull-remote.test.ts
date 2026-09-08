import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { sql } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { openDb, type Db } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import { fixtures } from './seed.ts';
import { pullRemote } from './pull-remote.ts';

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
