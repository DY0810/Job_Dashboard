import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { phaseFromLog, type Phase } from '@/lib/refresh-status';

/**
 * The refresh button. The pipeline — 18 connectors, enrich, ghost detection — runs on the
 * machine that holds `workie.db`, through the synchronous driver, and takes minutes. So
 * this route runs the real cycle where the pipeline lives and says so where it does not:
 * on Vercel there is nothing to run, only the copy the laptop last pushed.
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

export async function GET() {
  if (hosted()) return Response.json({ hosted: true, running: false, phase: 'idle' });
  const state = running();
  return Response.json({ hosted: false, running: state.running, phase: state.running ? phase(state.sinceMs) : 'idle' });
}

export async function POST() {
  if (hosted()) {
    return Response.json({ hosted: true, error: 'the pipeline runs on the laptop' }, { status: 501 });
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
