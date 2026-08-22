'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import type { Phase } from '@/lib/refresh-status';

type Status = { hosted: boolean; running: boolean; phase: Phase };

const LABEL: Record<Phase, string> = {
  idle: 'refresh',
  ingesting: 'polling every source…',
  enriching: 'classifying what came in…',
  syncing: 'new jobs in — syncing the hosted copy…',
  done: 'refreshed',
};

/**
 * Runs the real refresh cycle on demand, and shows which step it is on. New jobs appear the
 * moment enrich finishes — the table re-renders then, while the push to the hosted copy
 * carries on behind it. On the hosted site there is no pipeline to run: the button re-pulls
 * the copy the laptop last pushed, and the label says that rather than pretending.
 */
export function RefreshButton({ hosted }: { hosted: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const refreshedTable = useRef(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stop, []);

  const poll = () => {
    stop();
    refreshedTable.current = false;
    timer.current = setInterval(async () => {
      const res = await fetch('/api/refresh', { cache: 'no-store' }).catch(() => null);
      if (!res?.ok) return;
      const status = (await res.json()) as Status;
      const next: Phase = status.running ? status.phase : 'done';
      setPhase(next);
      // The table is worth re-rendering once enrich has run: that is when new rows exist.
      if ((next === 'syncing' || next === 'done') && !refreshedTable.current) {
        refreshedTable.current = true;
        router.refresh();
      }
      if (next === 'done') {
        stop();
        setTimeout(() => setPhase('idle'), 4000);
      }
    }, 2000);
  };

  const start = async () => {
    setNote(null);
    if (hosted) {
      // No pipeline here. Re-render from the replica and say where the data comes from.
      router.refresh();
      setNote('latest copy pulled — the laptop pushes new jobs every 30 minutes');
      return;
    }
    const res = await fetch('/api/refresh', { method: 'POST' }).catch(() => null);
    if (!res) return setNote('could not reach the server');
    if (res.status === 409) {
      setNote('a cycle is already running');
      setPhase('ingesting');
      return poll();
    }
    if (!res.ok) return setNote('could not start a cycle');
    setPhase('ingesting');
    poll();
  };

  const busy = phase !== 'idle' && phase !== 'done';
  return (
    <span className="inline-flex items-baseline gap-3">
      <button
        type="button"
        className="chip"
        onClick={start}
        disabled={busy}
        aria-busy={busy}
        aria-live="polite"
      >
        {LABEL[phase]}
      </button>
      {note ? <span className="text-[11px] text-fg-dim">{note}</span> : null}
    </span>
  );
}
