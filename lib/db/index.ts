import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { drizzle as drizzleTurso } from 'drizzle-orm/libsql/web';
import type BetterSqlite3 from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import type { LibSQLDatabase } from 'drizzle-orm/libsql';
import * as schema from './schema.ts';

/**
 * Two drivers, one read path.
 *
 * Locally the database is a file and better-sqlite3 reads it synchronously; hosted, it is
 * Turso and libSQL returns a Promise from every statement. `lib/query.ts` awaits, and `await`
 * on a non-Promise is a no-op — so the same query code serves both without branching.
 *
 * `Db` stays the synchronous handle: it is what `openDb()` returns and what the whole write
 * pipeline in `scripts/` is typed against, transactions included. Only the read path widens
 * to `ReadDb`, and widening it is what forces every read to be awaited.
 */
export type Db = BetterSQLite3Database<typeof schema>;

/** The hosted driver. Every statement it builds resolves to a Promise. */
export type TursoDb = LibSQLDatabase<typeof schema>;

/** Either driver — what `lib/query.ts` accepts and what `getDb()` hands it. */
export type ReadDb = Db | TursoDb;

/**
 * Both drivers build the identical statement and differ only in whether executing it returns
 * a Promise, but TypeScript cannot call a method through a union of overloaded signatures. So
 * reads are built through the async driver's type — the stricter of the two, because every
 * result then has to be awaited, which is exactly what keeps one code path correct on
 * better-sqlite3 and on Turso.
 */
export const driver = (db: ReadDb): TursoDb => db as TursoDb;

/** What a hosted deploy needs. Named here so the unconfigured page can name them too. */
export const TURSO_ENV = ['TURSO_DATABASE_URL', 'TURSO_AUTH_TOKEN'] as const;

/**
 * One connection per process. Next's dev server re-evaluates modules on every edit, so the
 * handle is cached on `globalThis` — otherwise each hot reload leaks a file descriptor.
 */
const cache = globalThis as typeof globalThis & { __workieDb?: ReadDb };

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/**
 * better-sqlite3 is a native addon, and `drizzle-orm/better-sqlite3` imports it statically —
 * so a static import here would drag the binary into a serverless bundle that reads Turso and
 * never calls `openDb()`. Requiring both at call time keeps them out of it. drizzle's cross-
 * copy checks are global symbols, so the CJS copy interoperates with the ESM one everything
 * else imports.
 */
const nodeRequire = createRequire(import.meta.url);

/**
 * A fresh, uncached handle. `getDb()` below is the app's cached singleton; this is what the
 * connector scripts and their tests use, because a test needs its own `:memory:` database
 * with the migrations applied and the singleton would hand back a shared one.
 *
 * Synchronous, and stays synchronous: `scripts/` runs 81 sync statements and four sync
 * transactions through it.
 */
export function openDb(
  path: string = process.env.WORKIE_DB ?? 'workie.db',
  options: { migrate?: boolean } = {},
): Db {
  const Database = nodeRequire('better-sqlite3') as typeof BetterSqlite3;
  const { drizzle } = nodeRequire(
    'drizzle-orm/better-sqlite3',
  ) as typeof import('drizzle-orm/better-sqlite3');
  const { migrate } = nodeRequire(
    'drizzle-orm/better-sqlite3/migrator',
  ) as typeof import('drizzle-orm/better-sqlite3/migrator');

  const sqlite = new Database(path);
  // The cron ingest writes to this file while the server reads it. Without WAL a page
  // load waits out the write lock and then throws SQLITE_BUSY.
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  if (options.migrate) migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

/**
 * Whether the app should read the hosted Turso replica instead of a local file.
 *
 * Presence of a credential is not intent to use it: the setup wizard writes
 * TURSO_DATABASE_URL into `.env.local` so `push:remote` can mirror the corpus up, and
 * Next.js loads that same file for the app — which silently switched a machine with a
 * perfectly good `workie.db` onto the network (measured: 1-2ms warm queries became
 * 52-60ms, and 1.1s cold). Turso is for where no local database can exist — Vercel, or
 * a machine without the file — plus WORKIE_DB_DRIVER=turso as a deliberate override.
 */
export function prefersTurso(
  env: Record<string, string | undefined> = process.env,
  hasLocalDb: boolean = existsSync(env.WORKIE_DB ?? 'workie.db'),
): boolean {
  if (!env.TURSO_DATABASE_URL) return false;
  if (env.WORKIE_DB_DRIVER === 'turso') return true;
  return Boolean(env.VERCEL) || !hasLocalDb;
}

export function getDb(): ReadDb {
  cache.__workieDb ??= prefersTurso()
    ? drizzleTurso({
        connection: {
          url: process.env.TURSO_DATABASE_URL!,
          authToken: process.env.TURSO_AUTH_TOKEN,
        },
        schema,
      })
    : openDb();
  return cache.__workieDb;
}

/**
 * True when there is no database to open at all. A serverless deploy has no `workie.db` on
 * disk, so `TURSO_DATABASE_URL` is the only way in — and the deployment URL exists before the
 * Turso database does. The page renders a configuration state rather than a stack trace.
 */
export function needsTurso(env: Record<string, string | undefined> = process.env): boolean {
  return !env.TURSO_DATABASE_URL && !!env.VERCEL;
}
