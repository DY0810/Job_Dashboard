import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient } from '@libsql/client';
import { eq, getTableName, sql } from 'drizzle-orm';
import { getAuthTables } from 'better-auth/db';
import { getPrivateDb, migratePrivateDb, openPrivateDb, PrivateConfigurationError, type PrivateDb } from './index.ts';
import * as schema from './schema.ts';

vi.mock('server-only', () => ({}));
vi.mock('@libsql/client', async (original) => {
  const actual = await original<typeof import('@libsql/client')>();
  return { ...actual, createClient: vi.fn(actual.createClient) };
});

let dir: string;
const opened: PrivateDb[] = [];
const now = new Date('2026-09-20T12:34:56.789Z');
const migrationCount = JSON.parse(readFileSync(new URL('../../drizzle-private/meta/_journal.json', import.meta.url), 'utf8')).entries.length;
const person = (id: string) => ({
  id, name: id, email: `${id}@example.test`, emailVerified: false, createdAt: now, updatedAt: now,
});
function open(name = 'private.db') {
  const db = openPrivateDb({ url: pathToFileURL(join(dir, name)).href });
  opened.push(db);
  return db;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'workie-private-'));
  vi.stubEnv('WORKIE_DB', join(dir, 'corpus.db'));
  vi.stubEnv('TURSO_DATABASE_URL', '');
  vi.stubEnv('WORKIE_PRIVATE_DATABASE_URL', '');
  vi.stubEnv('WORKIE_PRIVATE_DATABASE_AUTH_TOKEN', '');
  vi.stubEnv('VERCEL', '');
  vi.clearAllMocks();
});
afterEach(() => {
  for (const db of opened.splice(0)) db.$client.close();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe('private configuration before any client construction', () => {
  it.each(['', ' ', 'workie.db', ':memory:', 'file::memory:', 'ftp://private.test/db',
    'https://user:secret@private.test', 'https://private.test/?authToken=secret',
    'libsql://private.test?tls=0', 'file://elsewhere/private.db', 'file:/private.db#secret',
    'https://private.test\\other', 'https://private.test/\n', 'http://external.test'])(
    'rejects invalid target %j without leaking it', (url) => {
      expect(() => openPrivateDb({ url })).toThrow(PrivateConfigurationError);
      expect(createClient).not.toHaveBeenCalled();
      try { openPrivateDb({ url }); } catch (error) {
        expect(String(error)).not.toContain('secret');
      }
    },
  );

  it('requires explicit configuration locally and on Vercel without fallback', () => {
    expect(getPrivateDb).toThrow(PrivateConfigurationError);
    vi.stubEnv('VERCEL', '1');
    expect(getPrivateDb).toThrow(PrivateConfigurationError);
    vi.stubEnv('WORKIE_PRIVATE_DATABASE_URL', pathToFileURL(join(dir, 'private.db')).href);
    expect(getPrivateDb).toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'private.db'))).toBe(false);
    expect(existsSync(join(dir, 'corpus.db'))).toBe(false);
  });

  it('rejects corpus paths, encoded aliases, directory symlinks, and hard links', () => {
    const corpus = join(dir, 'corpus.db');
    writeFileSync(corpus, 'untouched corpus', { mode: 0o600 });
    symlinkSync(corpus, join(dir, 'alias.db'));
    symlinkSync(dir, join(dir, 'alias-dir'));
    linkSync(corpus, join(dir, 'hardlink.db'));
    for (const path of [corpus, join(dir, 'alias.db'), join(dir, 'hardlink.db'),
      join(dir, 'alias-dir', 'corpus.db')]) {
      expect(() => openPrivateDb({ url: pathToFileURL(path).href })).toThrow(PrivateConfigurationError);
    }
    expect(() => openPrivateDb({ url: `file:${dir}/%63orpus.db` })).toThrow(PrivateConfigurationError);
    expect(() => openPrivateDb({ url: 'file:workie.db' })).toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
    expect(readFileSync(corpus, 'utf8')).toBe('untouched corpus');
  });

  it('rejects dangling symlinks to a not-yet-created corpus path', () => {
    symlinkSync(join(dir, 'corpus.db'), join(dir, 'dangling.db'));
    expect(() => openPrivateDb({ url: pathToFileURL(join(dir, 'dangling.db')).href }))
      .toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'corpus.db'))).toBe(false);
  });

  it('compares the actual corpus path when a symlink is followed by dot-dot', () => {
    mkdirSync(join(dir, 'actual'));
    mkdirSync(join(dir, 'actual', 'child'));
    symlinkSync(join(dir, 'actual', 'child'), join(dir, 'link'));
    const corpus = join(dir, 'actual', 'corpus.db');
    writeFileSync(corpus, 'untouched', { mode: 0o600 });
    vi.stubEnv('WORKIE_DB', `${dir}/link/../corpus.db`);
    expect(() => openPrivateDb({ url: pathToFileURL(corpus).href })).toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it.each([
    ['libsql://CORPUS.test', 'https://corpus.test/'],
    ['https://corpus.test:443', 'libsql://corpus.test'],
    ['https://corpus.test.:8443/path', 'libsql://corpus.test'],
  ])('rejects same corpus host across protocols: %s', (url, corpusUrl) => {
    expect(() => openPrivateDb({ url, authToken: 'synthetic' }, { corpusUrl }))
      .toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('applies the explicit corpus file guard and rejects invalid tokens before opening', () => {
    const url = pathToFileURL(join(dir, 'private.db')).href;
    expect(() => openPrivateDb({ url }, { corpusUrl: url })).toThrow(PrivateConfigurationError);
    expect(() => openPrivateDb({ url }, { corpusPath: join(dir, 'private.db') }))
      .toThrow(PrivateConfigurationError);
    expect(() => openPrivateDb({ url, authToken: 'secret\ninjected' }))
      .toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'private.db'))).toBe(false);
  });

  it.each(['libsql://private.example.test', 'https://private.example.test'])(
    'constructs the real HTTP driver for %s, with mocked transport only', async (url) => {
      vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
      const db = openPrivateDb({ url, authToken: 'synthetic-only' }, { corpusUrl: 'libsql://corpus.example.test' });
      opened.push(db);
      expect(db.$client.protocol).toBe('http');
      expect(createClient).toHaveBeenCalledWith(expect.objectContaining({ authToken: 'synthetic-only' }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  );

  it('caches a lazy configured handle but still fails closed after config removal', () => {
    vi.stubEnv('WORKIE_PRIVATE_DATABASE_URL', pathToFileURL(join(dir, 'private.db')).href);
    const db = getPrivateDb();
    opened.push(db);
    expect(getPrivateDb()).toBe(db);
    expect(createClient).toHaveBeenCalledTimes(1);
    vi.stubEnv('WORKIE_PRIVATE_DATABASE_URL', '');
    expect(getPrivateDb).toThrow(PrivateConfigurationError);
  });

  it('requires the separate hosted token and uses the configured hosted URL without a local fallback', () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('WORKIE_PRIVATE_DATABASE_URL', 'libsql://private.example.test');
    vi.stubEnv('TURSO_DATABASE_URL', 'libsql://corpus.example.test');
    expect(getPrivateDb).toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
    vi.stubEnv('WORKIE_PRIVATE_DATABASE_AUTH_TOKEN', 'synthetic-only');
    const db = getPrivateDb();
    opened.push(db);
    expect(db.$client.protocol).toBe('http');
    expect(createClient).toHaveBeenCalledWith({
      url: 'https://private.example.test/', authToken: 'synthetic-only',
    });
    expect(existsSync(join(dir, 'corpus.db'))).toBe(false);
  });
});

describe('private migrations, adapter schema, and real async libSQL', () => {
  it('creates private database files without group or other access', () => {
    open();
    expect(statSync(join(dir, 'private.db')).mode & 0o077).toBe(0);
  });

  it('rejects a group-readable existing private file before opening it', () => {
    writeFileSync(join(dir, 'private.db'), '', { mode: 0o644 });
    chmodSync(join(dir, 'private.db'), 0o644);
    expect(() => open()).toThrow(PrivateConfigurationError);
    expect(createClient).not.toHaveBeenCalled();
  });

  it('upgrades an existing private database without replacing its preexisting records', async () => {
    const db = open();
    await db.run(sql`create table previous_private_state (id text primary key, value text not null)`);
    await db.run(sql`insert into previous_private_state values ('existing', 'preserved')`);
    await migratePrivateDb(db);
    await db.insert(schema.user).values(person('upgraded'));
    expect(await db.all(sql`select * from previous_private_state`))
      .toEqual([{ id: 'existing', value: 'preserved' }]);
    await migratePrivateDb(db);
    expect(await db.select().from(schema.user)).toHaveLength(1);
  });

  it('opens without migrating, then explicitly migrates fresh and reopened databases', async () => {
    const db = open();
    expect(await db.all(sql`select name from sqlite_master where type = 'table'`)).toEqual([]);
    await migratePrivateDb(db);
    await db.insert(schema.user).values(person('one'));
    db.$client.close();
    const reopened = open();
    await migratePrivateDb(reopened);
    expect(await reopened.select().from(schema.user)).toEqual([expect.objectContaining(person('one'))]);
    expect(await reopened.all(sql`select * from __drizzle_migrations`)).toHaveLength(migrationCount);
  });

  it('runs the explicit migration CLI from another cwd only against its configured scratch target', async () => {
    const script = fileURLToPath(new URL('../../scripts/private-migrate.ts', import.meta.url));
    const run = (url?: string) => spawnSync(process.execPath, ['--conditions=react-server', script], {
      cwd: dir,
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        NODE_ENV: 'test',
        PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        WORKIE_DB: join(dir, 'corpus.db'),
        ...(url ? { WORKIE_PRIVATE_DATABASE_URL: url } : {}),
      },
    });
    const unavailable = run();
    expect(unavailable.status).toBe(1);
    expect(unavailable.stderr).toContain('Private storage unavailable');
    expect(existsSync(join(dir, 'corpus.db'))).toBe(false);
    const url = pathToFileURL(join(dir, 'cli.db')).href;
    expect(run(url).status).toBe(0);
    expect(run(url).status).toBe(0);
    const db = open('cli.db');
    expect(await db.all(sql`select * from __drizzle_migrations`)).toHaveLength(migrationCount);
    expect(await db.select().from(schema.user)).toEqual([]);
  }, 35_000);

  it('matches pinned Better Auth fields and preserves millisecond dates and numeric rate limits', async () => {
    const db = open();
    await migratePrivateDb(db);
    const tables = getAuthTables({ rateLimit: { storage: 'database' } });
    for (const name of ['user', 'session', 'account', 'verification', 'rateLimit'] as const) {
      for (const field of Object.keys(tables[name].fields)) expect(schema[name]).toHaveProperty(field);
    }
    await db.insert(schema.user).values(person('one'));
    await db.insert(schema.session).values({
      id: 's1', token: 'token', userId: 'one', expiresAt: now, createdAt: now, updatedAt: now,
    });
    await db.insert(schema.account).values({
      id: 'a1', accountId: 'one', providerId: 'credential', userId: 'one',
      createdAt: now, updatedAt: now, accessTokenExpiresAt: now, refreshTokenExpiresAt: now,
    });
    await db.insert(schema.verification).values([
      { id: 'v1', identifier: 'same', value: 'one', expiresAt: now, createdAt: now, updatedAt: now },
      { id: 'v2', identifier: 'same', value: 'two', expiresAt: now, createdAt: now, updatedAt: now },
    ]);
    await db.insert(schema.rateLimit).values({ id: 'r1', key: 'key', count: 1, lastRequest: now.getTime() });
    expect((await db.select().from(schema.user))[0]).toMatchObject({ emailVerified: false, createdAt: now });
    expect((await db.select().from(schema.session))[0]).toMatchObject({ expiresAt: now, updatedAt: now });
    expect((await db.select().from(schema.account))[0]).toMatchObject({ accessTokenExpiresAt: now, refreshTokenExpiresAt: now });
    expect((await db.select().from(schema.verification))[0].expiresAt).toEqual(now);
    expect((await db.select().from(schema.rateLimit))[0].lastRequest).toBe(now.getTime());
    await expect(db.insert(schema.rateLimit).values({ id: 'r2', key: 'key', count: 1, lastRequest: now.getTime() }))
      .rejects.toThrow();
    await expect(db.run(sql`update private_rate_limit set last_request = 1.5`)).rejects.toThrow();
    await expect(db.run(sql`update private_rate_limit set count = -1`)).rejects.toThrow();
    const indexes = await db.all<{ name: string; unique: number }>(sql`pragma index_list('private_verification')`);
    expect(indexes).toContainEqual(expect.objectContaining({ name: 'private_verification_identifier_idx', unique: 0 }));
  });

  it('enforces uniqueness, boolean checks and parent foreign keys, including new transaction connections', async () => {
    const db = open();
    await migratePrivateDb(db);
    await db.insert(schema.user).values(person('one'));
    await expect(db.insert(schema.user).values({ ...person('two'), email: 'one@example.test' })).rejects.toThrow();
    await expect(db.run(sql`update private_user set email_verified = 2`)).rejects.toThrow();
    const session = { id: 's1', token: 'unique', userId: 'one', expiresAt: now, createdAt: now, updatedAt: now };
    await db.insert(schema.session).values(session);
    await expect(db.insert(schema.session).values({ ...session, id: 's2' })).rejects.toThrow();
    await expect(db.insert(schema.account).values({
      id: 'orphan', accountId: 'orphan', providerId: 'credential', userId: 'absent', createdAt: now, updatedAt: now,
    })).rejects.toThrow();
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.session).values({ ...session, id: 's3', token: 'other', userId: 'absent' });
    })).rejects.toThrow();
    await expect(db.insert(schema.session).values({ ...session, id: 's4', token: 'four', userId: 'absent' }))
      .rejects.toThrow();
    await db.delete(schema.user).where(eq(schema.user.id, 'one'));
    expect(await db.select().from(schema.session)).toEqual([]);
  });

  it('rolls back writes after an awaited rejection and commits a successful async transaction', async () => {
    const db = open();
    await migratePrivateDb(db);
    await expect(db.transaction(async (tx) => {
      await tx.insert(schema.user).values(person('rolled-back'));
      await new Promise((resolve) => setTimeout(resolve, 1));
      throw new Error('synthetic rollback');
    })).rejects.toThrow('synthetic rollback');
    expect(await db.select().from(schema.user)).toEqual([]);
    await db.transaction(async (tx) => {
      await tx.insert(schema.user).values(person('committed'));
      await Promise.resolve();
      await tx.update(schema.user).set({ name: 'Committed' }).where(eq(schema.user.id, 'committed'));
    });
    expect(await db.select().from(schema.user)).toEqual([expect.objectContaining({ id: 'committed', name: 'Committed' })]);
  });
});

it('keeps private rows out of a scratch collector push/pull/cache archive', async () => {
  const { openDb } = await import('../db/index.ts');
  const { TABLES, pushRemote } = await import('../../scripts/push-remote.ts');
  const { pullRemote, ensureCachedState } = await import('../../scripts/pull-remote.ts');
  const { fixtures } = await import('../../scripts/seed.ts');
  const { postings } = await import('../db/schema.ts');
  const { execFileSync } = await import('node:child_process');
  const db = open();
  await migratePrivateDb(db);
  await db.insert(schema.user).values(person('private-canary'));
  const corpusPath = join(dir, 'corpus.db');
  const corpus = openDb(corpusPath, { migrate: true });
  corpus.insert(postings).values(fixtures(now.getTime())).run();
  const before = readFileSync(join(dir, 'private.db'));
  const remote = pathToFileURL(join(dir, 'remote.db')).href;
  await pushRemote(remote, undefined);
  const restored = join(dir, 'workie.db');
  await pullRemote(remote, undefined, restored);
  expect(await ensureCachedState(remote, undefined, restored)).toBe(false);
  expect(readFileSync(join(dir, 'private.db'))).toEqual(before);
  expect(TABLES.map(getTableName)).toEqual(['postings', 'posting_sources', 'connector_runs']);
  const inspect = createClient({ url: pathToFileURL(restored).href });
  try {
    expect((await inspect.execute("select name from sqlite_master where name like 'private_%'")).rows).toEqual([]);
  } finally { inspect.close(); }
  const workflow = readFileSync(new URL('../../.github/workflows/refresh.yml', import.meta.url), 'utf8');
  const cachePaths = [...workflow.matchAll(/path: \|\n((?: {12}.+\n)+)/g)]
    .map((match) => match[1].trim().split('\n').map((line) => line.trim()));
  expect(cachePaths).toEqual([['workie.db', 'logs/.linkcheck-stamp'], ['workie.db', 'logs/.linkcheck-stamp']]);
  mkdirSync(join(dir, 'logs'));
  writeFileSync(join(dir, 'logs/.linkcheck-stamp'), 'synthetic');
  const archive = join(dir, 'cache.tar');
  execFileSync('/usr/bin/tar', ['-cf', archive, '-C', dir, ...cachePaths[0]]);
  expect(execFileSync('/usr/bin/tar', ['-tf', archive], { encoding: 'utf8' }).trim().split('\n'))
    .toEqual(cachePaths[0]);
  expect(readFileSync(archive).includes(Buffer.from('private-canary'))).toBe(false);
});
