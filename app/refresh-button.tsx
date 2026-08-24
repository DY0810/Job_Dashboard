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
 * carries on behind it.
 *
 * On the hosted site there is no pipeline to run, so the button ASKS: it records a request
 * in the shared database and watches for the laptop's next cycle to land. That is what lets
 * someone you shared the link with fetch new jobs without any access to your machine — and
 * if the machine is asleep, the request waits, which the label says rather than spinning.
 */
export function RefreshButton({ hosted }: { hosted: boolean }) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>('idle');
  const [note, setNote] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
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

  /**
   * On the hosted site there is no pipeline to start: it runs on the laptop that holds
   * workie.db. The ask is recorded in the shared database and the laptop claims it on its
   * next poll, so this watches for the laptop's cycle to land rather than pretending to run
   * one. If the laptop is asleep the request simply waits — said plainly, not spun.
   */
  const askLaptop = async () => {
    const by = (() => {
      try { return localStorage.getItem('talkie-author'); } catch { return null; }
    })();
    const res = await fetch(`/api/refresh${by ? `?by=${encodeURIComponent(by)}` : ''}`, {
      method: 'POST',
    }).catch(() => null);
    if (!res?.ok) return setNote('could not ask for a refresh');

    const since = ((await res.json()) as { lastRunAt: number | null }).lastRunAt;
    setWaiting(true);
    setNote('asked — your laptop picks this up within a minute');
    const askedAt = Date.now();
    stop();
    timer.current = setInterval(async () => {
      const poll = await fetch('/api/refresh', { cache: 'no-store' }).catch(() => null);
      if (!poll?.ok) return;
      const state = (await poll.json()) as { lastRunAt: number | null };
      if (state.lastRunAt && state.lastRunAt !== since) {
        stop();
        setWaiting(false);
        setNote('new jobs in');
        router.refresh();
        setTimeout(() => setNote(null), 5000);
        return;
      }
      if (Date.now() - askedAt > 6 * 60_000) {
        stop();
        setWaiting(false);
        setNote('no answer yet — the laptop may be asleep; it will run when it wakes');
      }
    }, 5000);
  };

  const start = async () => {
    setNote(null);
    if (hosted) return askLaptop();
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

  const busy = waiting || (phase !== 'idle' && phase !== 'done');
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
        {waiting ? 'waiting for the laptop…' : LABEL[phase]}
      </button>
      {note ? <span className="text-[11px] text-fg-dim">{note}</span> : null}
    </span>
  );
}
