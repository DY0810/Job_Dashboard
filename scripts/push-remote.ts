/**
 * `npm run push:remote` — mirror the local corpus into the hosted Turso database.
 *
 * The write pipeline stays where it is. Ingest, enrich, ghost and linkcheck all run against
 * the local `workie.db` with the synchronous driver and their transactions intact; this
 * copies the result up afterwards, so a hosted read replica costs the pipeline nothing.
 *
 * Idempotent, by upsert rather than by replace: every row is written under its local id and
 * overwrites whatever is there. That is what makes it safe to run at the end of every refresh
 * cycle, and it means a batch that fails leaves the site serving a complete-but-older corpus
 * rather than a half-empty one.
 *
 * Migrations are applied first, and drizzle's migrator skips the ones already recorded — so a
 * first run bootstraps an empty database and later runs are a no-op on that step.
 *
 *   npm run push:remote
 *   npm run push:remote -- --to=file:/tmp/mirror.db     a local libSQL file, no account
 *
 * Strays ARE deleted, and they have to be. This used to say that nothing here deletes, on the
 * grounds that ingest never removes a posting — delisting is a column. `merge:duplicates`
 * broke that: it collapses duplicate rows, and an upsert alone cannot express a deletion, so
 * the remote kept serving rows the local corpus had merged away. It also FAILED outright, and
 * the failure is worth keeping in mind because it is not obvious. Merging freed a `dedupe_key`
 * locally, the next ingest moved that key onto the surviving row, and upserting that row into a
 * remote where the deleted twin still held the key violated the UNIQUE index. Deleting first is
 * what makes the key available before anything claims it.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { getTableColumns, getTableName, inArray, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import { MIGRATIONS_DIR, openDb, type Db, type TursoDb } from '../lib/db/index.ts';
import * as schema from '../lib/db/schema.ts';

/** Parents before children: `posting_sources.posting_id` references `postings.id`. */
const TABLES = [schema.postings, schema.postingSources, schema.connectorRuns] as const;
type Mirrored = (typeof TABLES)[number];

/**
 * Rows per statement. Every column of every row is a bind parameter, and `postings` is ~30
 * columns wide with a full description in one of them — 100 keeps both the parameter count
 * and the request body well inside SQLite's and Turso's limits.
 */
const BATCH = 100;

/** `set` for an upsert that overwrites every non-key column with the row being inserted. */
function overwrite(table: Mirrored): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(getTableColumns(table))
      .filter(([, column]) => !column.primary)
      .map(([key, column]) => [key, sql.raw(`excluded.${column.name}`)]),
  );
}

/**
 * Remote ids the local corpus no longer has. Read back and diffed in memory rather than
 * expressed as `delete where id not in (...)`: the local corpus is ~15,000 rows, and inlining
 * that many bind parameters is the one thing BATCH exists to avoid.
 *
 * Children first at the call site, for the same reason the insert order is parents first.
 */
async function deleteStrays(remote: TursoDb, table: Mirrored, keep: Set<number>): Promise<number> {
  const remoteIds = (await remote.select({ id: table.id }).from(table)).map((row) => row.id);
  const strays = remoteIds.filter((id) => !keep.has(id));
  for (let start = 0; start < strays.length; start += BATCH) {
    await remote.delete(table).where(inArray(table.id, strays.slice(start, start + BATCH)));
  }
  return strays.length;
}

export async function mirrorTable(remote: TursoDb, local: Db, table: Mirrored): Promise<number> {
  // `select()` decodes (Date, boolean, parsed JSON) and `insert()` re-encodes, so the round
  // trip goes through the schema rather than around it.
  const rows = local.select().from(table).all();
  for (let start = 0; start < rows.length; start += BATCH) {
    await remote
      .insert(table)
      // The three row shapes differ; the loop is the same. One cast here beats three copies.
      .values(rows.slice(start, start + BATCH) as never)
      .onConflictDoUpdate({ target: table.id, set: overwrite(table) });
  }
  return rows.length;
}

export async function pushRemote(
  url: string,
  authToken: string | undefined,
): Promise<{ rows: number; deleted: number }[]> {
  const remote = drizzle(createClient({ url, authToken }), { schema });
  await migrate(remote, { migrationsFolder: MIGRATIONS_DIR });

  const local = openDb();

  /**
   * Two passes, in opposite orders, and they cannot be folded into one: a stray
   * `posting_sources` row must be deleted BEFORE the posting it points at, while a new source
   * row must be inserted AFTER it. Doing both per-table in one reversed loop inserts the
   * children first and trips the foreign key — which is exactly what it did on the first try.
   */
  const deleted = new Map<Mirrored, number>();
  for (const table of [...TABLES].reverse()) {
    const keep = new Set((local.select({ id: table.id }).from(table).all() as { id: number }[]).map((row) => row.id));
    deleted.set(table, await deleteStrays(remote, table, keep));
  }

  const counts: { rows: number; deleted: number }[] = [];
  for (const table of TABLES) {
    counts.push({ rows: await mirrorTable(remote, local, table), deleted: deleted.get(table) ?? 0 });
  }
  return counts;
}

function arg(name: string): string | undefined {
  const found = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

async function main(): Promise<void> {
  const url = arg('to') ?? process.env.TURSO_DATABASE_URL;
  if (!url) {
    throw new Error(
      'no target: set TURSO_DATABASE_URL (and TURSO_AUTH_TOKEN), or pass --to=file:/path.db',
    );
  }

  const started = Date.now();
  // The token is never logged, and `url` is printed only when it carries no credentials.
  const counts = await pushRemote(url, process.env.TURSO_AUTH_TOKEN);
  const lines = TABLES.map(
    (table, index) =>
      `  ${getTableName(table)}  ${counts[index].rows}` +
      (counts[index].deleted > 0 ? `  (${counts[index].deleted} stray row(s) deleted)` : ''),
  );
  console.log(
    [`pushed to ${url.startsWith('file:') ? url : new URL(url).host}`, ...lines, `  ${Date.now() - started}ms`].join(
      '\n',
    ),
  );
}

/**
 * The same lock `scripts/refresh.sh` takes for a whole cycle, because a cycle ends with this
 * script and a hand-run `npm run push:remote` would otherwise mirror alongside it. Two
 * mirrors race: one deletes strays computed from its own snapshot while the other inserts
 * children, and `posting_sources.posting_id` trips — Turso enforces foreign keys, local
 * SQLite does not, so it only ever fails against the hosted database. Observed exactly that
 * way: a scheduled cycle and a manual push overlapped and the run died mid-table.
 *
 * A cycle already running will push when it finishes, so refusing here loses nothing.
 */
function takeLock(): (() => void) | null {
  const dir = join(process.cwd(), 'logs');
  const lock = join(dir, '.refresh.lock');
  mkdirSync(dir, { recursive: true });
  try {
    mkdirSync(lock);
  } catch {
    const holder = Number(readFileSync(join(lock, 'pid'), 'utf8').trim());
    try {
      process.kill(holder, 0);
      return null; // A live cycle owns it; it will mirror at the end of its run.
    } catch {
      rmSync(lock, { recursive: true, force: true }); // Left by a cycle that died.
      mkdirSync(lock);
    }
  }
  writeFileSync(join(lock, 'pid'), String(process.pid));
  return () => rmSync(lock, { recursive: true, force: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const release = takeLock();
  if (!release) {
    console.log('a refresh cycle is running; it will mirror when it finishes');
    process.exit(0);
  }
  try {
    await main();
  } finally {
    release();
  }
}
