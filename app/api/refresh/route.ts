import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { driver, getDb, needsTurso } from '@/lib/db';
import { connectorRuns } from '@/lib/db/schema';
import { phaseFromLog, type Phase } from '@/lib/refresh-status';
import { pendingRequest, requestRefresh } from '@/lib/refresh-queue';
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

export async function GET() {
  if (hosted()) {
    // Nothing runs here. Report whether a request is still waiting for a runner, and when
    // a cycle last ran — the page watches that number to know its ask landed.
    if (needsTurso()) return Response.json({ hosted: true, queued: false, lastRunAt: null });
    const waiting = await pendingRequest(getDb());
    return Response.json({ hosted: true, queued: Boolean(waiting), lastRunAt: await lastRunAt() });
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
async function dispatchWorkflow(): Promise<void> {
  const token = process.env.WORKIE_GH_TOKEN;
  if (!token) return;
  const repo = process.env.WORKIE_GH_REPO ?? 'DY0810/Job_Dashboard';
  const res = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/refresh.yml/dispatches`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
    },
    body: JSON.stringify({ ref: 'main' }),
  });
  if (res.status !== 204) console.error('workflow dispatch', res.status, await res.text());
}

export async function POST(request: Request) {
  if (hosted()) {
    // The pipeline runs in GitHub Actions; leave a request and nudge the workflow to start.
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    try {
      const by = new URL(request.url).searchParams.get('by')?.slice(0, 40) || null;
      const { queued } = await requestRefresh(getDb(), by);
      await dispatchWorkflow().catch((error) => console.error('workflow dispatch', error));
      return Response.json({ hosted: true, queued, lastRunAt: await lastRunAt() }, { status: 202 });
    } catch (error) {
      console.error('POST /api/refresh (hosted)', error);
      return Response.json({ error: 'could not queue a refresh' }, { status: 500 });
    }
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
