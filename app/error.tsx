'use client';

import { AppNav } from './app-nav';

/**
 * The database is a local file that may not have been migrated yet, so the useful error
 * state names the command that fixes the common case instead of apologising.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="board-page">
      <header className="app-header"><AppNav current="/" /></header>
      <div className="prose max-w-lg py-12" role="alert">
        <p className="board-eyebrow">Job board</p>
        <h1 className="board-title">Couldn’t load jobs</h1>
        <p>Could not read the postings database.</p>
        <p className="mt-3">
          If this is a fresh checkout, run{' '}
          <code className="border border-rule bg-surface px-1 py-px text-fg">npm run db:migrate</code>{' '}
          and then{' '}
          <code className="border border-rule bg-surface px-1 py-px text-fg">npm run seed</code>.
        </p>
        {error.digest ? <p className="mt-3">Digest {error.digest}.</p> : null}
        <button type="button" className="chip mt-4" onClick={reset}>
          Retry
        </button>
      </div>
    </main>
  );
}
