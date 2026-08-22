import Link from 'next/link';

import { TURSO_ENV, getDb, needsTurso } from '@/lib/db';
import { listNotes, listWeeks, weekKey, weekLabel, weekRange } from '@/lib/notes';
import { Calendar } from '../icons';
import { Board } from './board';

export const dynamic = 'force-dynamic';

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
      <main className="min-h-dvh px-4 py-12 text-[11px] text-fg-dim">
        Database not configured: set {TURSO_ENV.join(' and ')}.
      </main>
    );
  }
  const db = getDb();
  const [notes, weeks] = await Promise.all([listNotes(db, week), listWeeks(db)]);
  const options = [current, ...weeks.filter((w) => w !== current)];

  return (
    <main className="min-h-dvh px-4 pb-16">
      <header className="flex items-baseline gap-6 border-b border-rule py-2">
        <h1 className="w-wide text-[13px] font-medium">Workie</h1>
        <nav className="flex gap-4" aria-label="Track">
          <Link href="/" className="w-wide pb-1 text-[11px] text-fg-dim hover:text-fg">design</Link>
          <Link href="/?tab=engineering" className="w-wide pb-1 text-[11px] text-fg-dim hover:text-fg">engineering</Link>
          <Link href="/talkie" aria-current="page" className="w-wide border-b border-fg pb-1 text-[11px] text-fg">talkie</Link>
        </nav>
        <details className="relative ml-auto">
          <summary className="chip flex cursor-pointer list-none items-center gap-1.5" aria-label="Pick a week">
            <Calendar />
            <span className="tabular-nums">{weekLabel(week)}</span>
            {week === current ? <span className="text-fg-dim">· this week</span> : null}
          </summary>
          <div className="weeks" role="list">
            {options.map((key) => (
              <Link key={key} href={key === current ? '/talkie' : `/talkie?week=${key}`} aria-current={key === week ? 'true' : undefined} role="listitem">
                <span className="tabular-nums">{weekLabel(key)}</span>
                {key === current ? <span className="text-fg-faint"> · this week</span> : null}
              </Link>
            ))}
          </div>
        </details>
      </header>
      <Board key={week} notes={notes} canWrite={week === current} />
    </main>
  );
}
