/**
 * `npm run claim:refresh` — the cloud writer's side of the hosted refresh button.
 *
 * Someone on the deployed site cannot start a cycle: the pipeline runs here, against the
 * local `workie.db`, through the synchronous driver. They leave a row in `refresh_requests`
 * on Turso instead; this claims the oldest unclaimed one and runs the ordinary cycle.
 *
 * GitHub Actions calls this with --always, so scheduled cycles run even without a request.
 * --catch-up advances pending large-catalog scans between successful hosted mirrors.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

import * as schema from '../lib/db/schema.ts';
import { claimRequest, finishRequest } from '../lib/refresh-queue.ts';
import { MIGRATIONS_DIR, openDb, type Db, type ReadDb, type TursoDb } from '../lib/db/index.ts';
import { readCheckpoints } from './ingest.ts';
import { connectors } from './connectors/index.ts';

export function runRefreshCycles(
  cycle: (pendingOnly: boolean) => number,
  checkpoints: () => ReturnType<typeof readCheckpoints>,
  catchUp = false,
  now: () => number = Date.now,
): number {
  const deadline = now() + 75 * 60_000;
  let code = cycle(false);
  while (code === 0 && catchUp) {
    const before = checkpoints();
    const pending = [...before].filter(([, state]) => state.pending).map(([name]) => name);
    console.log(JSON.stringify({ event: 'catch-up', pending }));
    if (pending.length === 0) return 0;
    if (now() >= deadline) return 75;
    code = cycle(true);
    if (code === 0 && JSON.stringify([...before]) === JSON.stringify([...checkpoints()])) {
      console.error('Catch-up made no checkpoint progress; stopping rather than repeating the same pages');
      return 1;
    }
  }
  return code;
}

export async function claimAndRun(run: () => number, db?: ReadDb): Promise<number | null> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url && !db) return null;
  const remote = db ?? drizzle({
    connection: { url: url!, authToken: process.env.TURSO_AUTH_TOKEN },
    schema,
  }) as unknown as ReadDb;

  // The queue is bookkeeping; the cycle is the point. A claim that cannot be written must not
  // decide whether jobs get fetched — when Turso blocked writes on a quota, this line threw,
  // `--always` below never ran, and five consecutive scheduled runs ingested NOTHING because a
  // row could not be updated. Treated as "nobody was waiting", which is the honest reading.
  let claimed: Awaited<ReturnType<typeof claimRequest>> = null;
  try {
    if (!db) await migrate(remote as TursoDb, { migrationsFolder: MIGRATIONS_DIR });
    claimed = await claimRequest(remote);
  } catch (error) {
    console.log(
      JSON.stringify({ event: 'refresh-claim-failed', reason: (error as Error).message.slice(0, 200) }),
    );
    return null;
  }
  if (!claimed) return null;
  console.log(
    JSON.stringify({
      event: 'refresh-request',
      id: claimed.id,
      by: claimed.requestedBy ?? '(anonymous)',
      requestedAt: claimed.requestedAt.toISOString(),
    }),
  );
  let code = 1;
  try {
    code = run();
  } finally {
    await finishRequest(remote, claimed, code === 0 ? null : `Refresh cycle exited with code ${code}`);
  }
  console.log(JSON.stringify({ event: 'refresh-request-done', id: claimed.id, exit: code }));
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The ordinary cycle, lock and all: a request that lands mid-cycle waits for the next tick
  // rather than starting a second ingest.
  const catchUp = process.argv.includes('--catch-up');
  let local: Db | undefined;
  const enabled = connectors.filter((connector) => !connector.skip?.(process.env));
  const enabledNames = new Set(enabled.map((connector) => connector.name));
  const cycle = () => runRefreshCycles(
    (pendingOnly) => spawnSync('bash', [
      'scripts/refresh.sh',
      ...(pendingOnly ? ['--pending'] : []),
      ...(catchUp ? ['--skip-linkcheck'] : []),
    ], { stdio: 'inherit' }).status ?? 1,
    () => new Map([...readCheckpoints(local ??= openDb(), enabled)].filter(([name]) => enabledNames.has(name))),
    catchUp,
  );
  const result = await claimAndRun(cycle);
  if (result === null) {
    // --always: this IS a scheduled run (the GitHub Actions runner), so an empty queue is
    // not a reason to skip the cycle — it just means nobody was waiting for this one.
    if (process.argv.includes('--always')) process.exit(cycle());
    process.exit(0);
  }
  process.exit(result);
}
