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
 * ponytail: nothing deletes remote rows. Ingest never deletes a posting — delisting is a
 * column — so the only strays are `npm run seed` fixtures, which a real corpus never has.
 * Add a delete-not-in pass if that stops being true.
 */

import { pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { getTableColumns, getTableName, sql } from 'drizzle-orm';
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

export async function pushRemote(url: string, authToken: string | undefined): Promise<number[]> {
  const remote = drizzle(createClient({ url, authToken }), { schema });
  await migrate(remote, { migrationsFolder: MIGRATIONS_DIR });

  const local = openDb();
  const counts: number[] = [];
  for (const table of TABLES) counts.push(await mirrorTable(remote, local, table));
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
  const lines = TABLES.map((table, index) => `  ${getTableName(table)}  ${counts[index]}`);
  console.log(
    [`pushed to ${url.startsWith('file:') ? url : new URL(url).host}`, ...lines, `  ${Date.now() - started}ms`].join(
      '\n',
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
