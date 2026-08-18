import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.ts';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * One connection per process. Next's dev server re-evaluates modules on every edit, so the
 * handle is cached on `globalThis` — otherwise each hot reload leaks a file descriptor.
 */
const cache = globalThis as typeof globalThis & { __workyDb?: Db };

export const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle');

/**
 * A fresh, uncached handle. `getDb()` below is the app's cached singleton; this is what the
 * connector scripts and their tests use, because a test needs its own `:memory:` database
 * with the migrations applied and the singleton would hand back a shared one.
 */
export function openDb(
  path: string = process.env.WORKY_DB ?? 'worky.db',
  options: { migrate?: boolean } = {},
): Db {
  const sqlite = new Database(path);
  // The cron ingest writes to this file while the server reads it. Without WAL a page
  // load waits out the write lock and then throws SQLITE_BUSY.
  sqlite.pragma('journal_mode = WAL');
  const db = drizzle(sqlite, { schema });
  if (options.migrate) migrate(db, { migrationsFolder: MIGRATIONS_DIR });
  return db;
}

export function getDb(): Db {
  cache.__workyDb ??= openDb();
  return cache.__workyDb;
}
