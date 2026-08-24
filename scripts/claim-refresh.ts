/**
 * `npm run claim:refresh` — the laptop's side of the hosted refresh button.
 *
 * Someone on the deployed site cannot start a cycle: the pipeline runs here, against the
 * local `workie.db`, through the synchronous driver. They leave a row in `refresh_requests`
 * on Turso instead; this claims the oldest unclaimed one and runs the ordinary cycle.
 *
 * Run on a short interval by launchd. Almost every tick finds nothing and exits 0 in the
 * time one round trip takes, which is why it polls rather than holding a connection open.
 * Needs TURSO_DATABASE_URL — without it there is no shared queue to read, and it exits 0.
 */

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { drizzle } from 'drizzle-orm/libsql';

import * as schema from '../lib/db/schema.ts';
import { claimRequest } from '../lib/refresh-queue.ts';
import type { ReadDb } from '../lib/db/index.ts';

export async function claimAndRun(run: () => number): Promise<'idle' | 'ran'> {
  const url = process.env.TURSO_DATABASE_URL;
  if (!url) return 'idle';
  const remote = drizzle({
    connection: { url, authToken: process.env.TURSO_AUTH_TOKEN },
    schema,
  }) as unknown as ReadDb;

  const claimed = await claimRequest(remote);
  if (!claimed) return 'idle';
  console.log(
    JSON.stringify({
      event: 'refresh-request',
      id: claimed.id,
      by: claimed.requestedBy ?? '(anonymous)',
      requestedAt: claimed.requestedAt.toISOString(),
    }),
  );
  const code = run();
  console.log(JSON.stringify({ event: 'refresh-request-done', id: claimed.id, exit: code }));
  return 'ran';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The ordinary cycle, lock and all: a request that lands mid-cycle waits for the next tick
  // rather than starting a second ingest.
  const cycle = () => spawnSync('bash', ['scripts/refresh.sh'], { stdio: 'inherit' }).status ?? 1;
  const result = await claimAndRun(cycle);
  if (result === 'idle') {
    // --always: this IS a scheduled run (the GitHub Actions runner), so an empty queue is
    // not a reason to skip the cycle — it just means nobody was waiting for this one.
    if (process.argv.includes('--always')) process.exit(cycle());
    process.exit(0);
  }
}
