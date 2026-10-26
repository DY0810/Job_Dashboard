'use client';

import { AppHeader } from './app-header';

/**
 * The database is a local file that may not have been migrated yet, so the useful error
 * state names the command that fixes the common case instead of apologising.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main-content" className="board-page">
      <AppHeader current="/" />
      <div className="prose max-w-lg py-12" role="alert">
        <p className="board-eyebrow label">Job board</p>
        <h1 className="board-title">Couldn’t load jobs</h1>
        <p>Could not read the postings database.</p>
        <p className="mt-3">
          If this is a fresh checkout, run <code>npm run db:migrate</code> and then <code>npm run seed</code>.
        </p>
        {error.digest ? <p className="mt-3">Digest {error.digest}.</p> : null}
        <button type="button" className="btn mt-4" onClick={reset}>
          Retry
        </button>
      </div>
    </main>
  );
}
