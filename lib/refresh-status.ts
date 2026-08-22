/**
 * What a refresh cycle is doing right now, read off its own log. `scripts/refresh.sh` logs
 * four markers in order — "cycle start", the ingest summary JSON, the enrich line, and
 * "cycle end" — so the phase is which of those has appeared since the cycle began.
 *
 * Pure: the route hands it the log text and the moment the lock was taken.
 */
export type Phase = 'idle' | 'ingesting' | 'enriching' | 'syncing' | 'done';

const STAMP = /^\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)\] /;

export function phaseFromLog(log: string, sinceMs: number): Phase {
  const lines = log.split('\n');
  // The last "cycle start" at or after the lock is this cycle; everything after it is ours.
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('cycle start')) continue;
    const stamp = STAMP.exec(lines[i])?.[1];
    // Allow a second of skew: the lock is taken a moment before the line is written.
    if (stamp && Date.parse(stamp) >= sinceMs - 1000) start = i;
    break;
  }
  if (start < 0) return 'idle';
  const ours = lines.slice(start + 1);
  if (ours.some((l) => l.includes('cycle end'))) return 'done';
  if (ours.some((l) => l.startsWith('enrich:'))) return 'syncing';
  if (ours.some((l) => l.includes('"event":"summary"'))) return 'enriching';
  return 'ingesting';
}
