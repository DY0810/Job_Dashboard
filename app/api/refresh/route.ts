import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { driver, getDb, needsTurso } from '@/lib/db';
import { connectorRuns } from '@/lib/db/schema';
import { phaseFromLog, type HostedRefreshStatus, type Phase } from '@/lib/refresh-status';
import { getRefreshRequest, requestRefresh, type RefreshRequest } from '@/lib/refresh-queue';
import { desc } from 'drizzle-orm';

/**
 * The refresh button. The pipeline — 18 connectors, enrich, ghost detection — runs on the
 * machine that holds `workie.db`, through the synchronous driver, and takes minutes. So
 * this route runs the real cycle where the pipeline lives and says so where it does not:
 * on Vercel there is nothing to run, only the copy the last cycle pushed. Scheduled cycles
 * run in GitHub Actions (.github/workflows/refresh.yml); a dev laptop still runs them
 * locally through this same route.
 *
 * Starting a cycle is `scripts/refresh.sh`, detached: the same script launchd runs, so a
 * manual refresh is a scheduled cycle that happened to start now, lock and all.
 */

const LOG_DIR = join(process.cwd(), 'logs');
const LOCK = join(LOG_DIR, '.refresh.lock');

function hosted(): boolean {
  return Boolean(process.env.VERCEL);
}

/**
 * Whether THIS process may start a cycle on the machine it runs on.
 *
 * Deliberately opt-in, and not the same question as `hosted()`. Asking "am I on Vercel?" made
 * the safe branch an accident of one provider's environment variable: anywhere `VERCEL` was
 * unset — a laptop running `next dev`, or anyone self-hosting this repo — an unauthenticated
 * POST spawned the pipeline. That POST carries no body and no custom header, so it is a CORS
 * simple request: any page in the browser could fire it cross-origin without a preflight.
 *
 * The spawn is not the whole cost. `scripts/refresh.sh` sources `.env.local`, so the cycle it
 * starts ends in `push-remote.ts`, whose `deleteStrays` removes every hosted row absent from
 * the local database. With the GitHub Actions schedule as the writer lineage, letting a
 * stranger choose that moment means letting them corrupt the hosted corpus.
 */
function mayRunLocally(): boolean {
  return process.env.WORKIE_ALLOW_LOCAL_REFRESH === '1';
}

/** The lock is a directory with a pid; a dead pid is a crashed cycle, not a running one. */
function running(): { running: boolean; sinceMs: number } {
  if (!existsSync(LOCK)) return { running: false, sinceMs: 0 };
  const sinceMs = statSync(LOCK).mtimeMs;
  try {
    const pid = Number(readFileSync(join(LOCK, 'pid'), 'utf8').trim());
    process.kill(pid, 0);
    return { running: true, sinceMs };
  } catch {
    return { running: false, sinceMs };
  }
}

function phase(sinceMs: number): Phase {
  if (!existsSync(LOG_DIR)) return 'idle';
  const newest = readdirSync(LOG_DIR)
    .filter((name) => /^refresh-\d{4}-\d{2}-\d{2}\.log$/.test(name))
    .sort()
    .at(-1);
  if (!newest) return 'idle';
  return phaseFromLog(readFileSync(join(LOG_DIR, newest), 'utf8'), sinceMs);
}

/** When a cycle last ran — how the hosted page knows its request landed. */
async function lastRunAt(): Promise<number | null> {
  if (needsTurso()) return null;
  const row = await driver(getDb())
    .select({ startedAt: connectorRuns.startedAt })
    .from(connectorRuns)
    .orderBy(desc(connectorRuns.startedAt))
    .limit(1)
    .get();
  return row?.startedAt.getTime() ?? null;
}

function publicRequest(request: RefreshRequest | null): HostedRefreshStatus['request'] {
  if (!request) return null;
  return {
    id: request.id,
    status: request.completedAt
      ? (request.error ? 'failed' : 'succeeded')
      : (request.claimedAt ? 'running' : 'queued'),
    completedAt: request.completedAt?.getTime() ?? null,
    error: request.error,
  };
}

export async function GET(request: Request) {
  if (hosted()) {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    const rawId = new URL(request.url).searchParams.get('request');
    const id = rawId === null ? undefined : Number(rawId);
    if (id !== undefined && (!Number.isSafeInteger(id) || id < 1)) {
      return Response.json({ error: 'invalid request id' }, { status: 400 });
    }
    const [latest, last] = await Promise.all([getRefreshRequest(getDb(), id), lastRunAt()]);
    return Response.json({
      hosted: true,
      queued: Boolean(latest && !latest.completedAt && !latest.claimedAt),
      lastRunAt: last,
      dispatchConfigured: Boolean(process.env.WORKIE_GH_TOKEN?.trim()),
      request: publicRequest(latest),
    } satisfies HostedRefreshStatus);
  }
  const state = running();
  return Response.json({ hosted: false, running: state.running, phase: state.running ? phase(state.sinceMs) : 'idle' });
}

/**
 * Best-effort nudge: with a GitHub token configured, a click starts the Actions cycle now
 * instead of waiting for the next half-hour tick. The queue row above is still the record —
 * a failed dispatch just means the scheduled run claims it instead, so errors are logged
 * and swallowed.
 */
async function dispatchWorkflow(): Promise<HostedRefreshStatus['dispatch']> {
  const token = process.env.WORKIE_GH_TOKEN?.trim();
  if (!token) return 'scheduled';
  const repo = process.env.WORKIE_GH_REPO ?? 'DY0810/Job_Dashboard';
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/refresh.yml/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ ref: 'main' }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 204) return 'started';
  console.error('workflow dispatch failed', res.status);
  return 'failed';
}

export async function POST(request: Request) {
  if (hosted()) {
    // The pipeline runs in GitHub Actions; leave a request and nudge the workflow to start.
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    try {
      const by = new URL(request.url).searchParams.get('by')?.slice(0, 40) || null;
      const { request: entry, queued: created } = await requestRefresh(getDb(), by);
      const dispatch = created
        ? await dispatchWorkflow().catch(() => 'failed' as const)
        : 'coalesced';
      return Response.json({
        hosted: true,
        queued: !entry.claimedAt,
        lastRunAt: await lastRunAt(),
        dispatchConfigured: Boolean(process.env.WORKIE_GH_TOKEN?.trim()),
        dispatch,
        request: publicRequest(entry),
      } satisfies HostedRefreshStatus, { status: 202 });
    } catch (error) {
      console.error('POST /api/refresh (hosted)', error);
      return Response.json({ error: 'could not queue a refresh' }, { status: 500 });
    }
  }
  if (!mayRunLocally()) {
    return Response.json(
      { error: 'local refresh is disabled; set WORKIE_ALLOW_LOCAL_REFRESH=1 to enable it' },
      { status: 403 },
    );
  }
  const state = running();
  if (state.running) {
    return Response.json({ running: true, phase: phase(state.sinceMs) }, { status: 409 });
  }
  try {
    const child = spawn('bash', ['scripts/refresh.sh'], {
      cwd: process.cwd(),
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return Response.json({ started: true }, { status: 202 });
  } catch (error) {
    console.error('POST /api/refresh', error);
    return Response.json({ error: 'could not start a cycle' }, { status: 500 });
  }
}
