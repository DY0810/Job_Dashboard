import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

export type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * One connection per process. Next's dev server re-evaluates modules on every edit, so the
 * handle is cached on `globalThis` — otherwise each hot reload leaks a file descriptor.
 */
const cache = globalThis as typeof globalThis & { __workyDb?: Db };

export function getDb(): Db {
  if (!cache.__workyDb) {
    const sqlite = new Database(process.env.WORKY_DB ?? 'worky.db');
    // The cron ingest writes to this file while the server reads it. Without WAL a page
    // load waits out the write lock and then throws SQLITE_BUSY.
    sqlite.pragma('journal_mode = WAL');
    cache.__workyDb = drizzle(sqlite, { schema });
  }
  return cache.__workyDb;
}
