/**
 * `npm run pull:remote` — bootstrap a local `workie.db` from the hosted Turso mirror.
 *
 * The exact inverse of `push-remote.ts`, and it exists for the same reason in the other
 * direction: the pipeline is stateful. Dedupe keys, ghost absence counts, `first_seen_run`
 * and delistings all live in the local file, and a runner that starts without them would
 * re-ingest the world as brand new — then mirror that amnesia up, deleting every remote row
 * it no longer recognises. Turso holds every mirrored column, so the hosted copy IS the
 * backup; this restores it.
 *
 * Refuses to overwrite a database that already has postings — a bootstrap tool, not a sync.
 * `--force` for when you really do want to rebuild the file from the remote.
 *
 *   npm run pull:remote
 *   npm run pull:remote -- --from=file:/tmp/mirror.db    a local libSQL file, for tests
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { createClient } from '@libsql/client';
import { getTableName, gt, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/libsql';

import { openDb, type Db, type TursoDb } from '../lib/db/index.ts';
import * as schema from '../lib/db/schema.ts';
import { TABLES, type Mirrored } from './push-remote.ts';

/** Rows per page. Descriptions make `postings` rows heavy; 200 keeps each response modest. */
const PAGE = 200;

async function pullTable(remote: TursoDb, local: Db, table: Mirrored): Promise<number> {
  let last = 0;
  let total = 0;
  for (;;) {
    // Keyset pagination, not OFFSET: the remote is ~20,000 rows and OFFSET re-reads them all.
    const rows = await remote
      .select()
      .from(table)
      .where(gt(table.id, last))
      .orderBy(table.id)
      .limit(PAGE);
    if (rows.length === 0) return total;
    // Same round trip as the push, reversed: remote `select()` decodes through the schema,
    // local `insert()` re-encodes through it.
    local.insert(table).values(rows as never).run();
    last = rows[rows.length - 1]!.id;
    total += rows.length;
  }
}

export async function pullRemote(
  url: string,
  authToken: string | undefined,
  path?: string,
): Promise<{ table: string; rows: number }[]> {
  const remote = drizzle(createClient({ url, authToken }), { schema });
  const local = openDb(path, { migrate: true });

  const counts: { table: string; rows: number }[] = [];
  // Parents before children, same order the push inserts in and for the same foreign key.
  for (const table of TABLES) {
    counts.push({ table: getTableName(table), rows: await pullTable(remote, local, table) });
  }
  return counts;
}

function arg(name: string): string | undefined {
  const found = process.argv.slice(2).find((value) => value.startsWith(`--${name}=`));
  return found?.slice(name.length + 3);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const url = arg('from') ?? process.env.TURSO_DATABASE_URL;
  if (!url) throw new Error('no source: set TURSO_DATABASE_URL, or pass --from=file:/path.db');

  const path = process.env.WORKIE_DB ?? 'workie.db';
  if (existsSync(path) && !process.argv.includes('--force')) {
    // `openDb` would create an empty file, so existence alone is the guard — a database
    // already here is the pipeline's working state, and clobbering it loses id lineage.
    const rows = openDb(path, { migrate: true }).select({ n: sql<number>`count(*)` }).from(schema.postings).get();
    if ((rows?.n ?? 0) > 0) {
      throw new Error(`${path} already has ${rows!.n} postings; pass --force to rebuild it from the remote`);
    }
  }

  const started = Date.now();
  const counts = await pullRemote(url, process.env.TURSO_AUTH_TOKEN, path);
  console.log(
    [
      `pulled from ${url.startsWith('file:') ? url : new URL(url).host} into ${path}`,
      ...counts.map(({ table, rows }) => `  ${table}  ${rows}`),
      `  ${Date.now() - started}ms`,
    ].join('\n'),
  );
}
