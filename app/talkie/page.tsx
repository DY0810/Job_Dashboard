import type { Metadata } from 'next';
import Link from 'next/link';

import { TURSO_ENV, getDb, needsTurso } from '@/lib/db';
import { listNotes, listWeeks, weekKey, weekLabel, weekRange } from '@/lib/notes';
import { Calendar } from 'lucide-react';
import { Board } from './board';
import { AppHeader } from '../app-header';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = { title: 'Notes | Workie' };

/**
 * Talkie: the shared notes board. Its own route rather than a `?tab=`: the job tabs are held
 * at the edge for five minutes, which would hide a fresh note, and it shares none of their
 * filters, sort or drawer. Every view is a week; this week is writable, earlier weeks are kept.
 */
export default async function Talkie({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const requested = (await searchParams).week;
  const current = weekKey(new Date());
  const week = typeof requested === 'string' && weekRange(requested) ? requested : current;

  if (needsTurso()) {
    return (
      <main id="main-content" className="min-h-dvh">
        <AppHeader current="/talkie" />
        <p className="muted py-12">Database not configured: set {TURSO_ENV.join(' and ')}.</p>
      </main>
    );
  }
  const db = getDb();
  const [notes, weeks] = await Promise.all([listNotes(db, week), listWeeks(db)]);
  const options = [current, ...weeks.filter((w) => w !== current)];

  return (
    <main id="main-content" className="min-h-dvh px-4 pb-16">
      <AppHeader current="/talkie" />
      <div className="flex flex-wrap items-center gap-3 pt-2.5 pb-4">
        <h1 className="board-title">Notes</h1>
        <details className="relative ml-auto">
          <summary className="btn list-none" aria-label="Pick a week">
            <Calendar size={16} strokeWidth={1.75} aria-hidden="true" className="text-fg-dim" />
            <span className="tabular-nums">{weekLabel(week)}</span>
            {week === current ? <span className="text-fg-dim">· this week</span> : null}
          </summary>
          <div className="weeks" role="list">
            {options.map((key) => (
              <Link key={key} href={key === current ? '/talkie' : `/talkie?week=${key}`} aria-current={key === week ? 'true' : undefined} role="listitem">
                <span className="tabular-nums">{weekLabel(key)}</span>
                {key === current ? <span className="text-fg-dim"> · this week</span> : null}
              </Link>
            ))}
          </div>
        </details>
      </div>
      <Board key={week} notes={notes} canWrite={week === current} week={week} />
    </main>
  );
}
