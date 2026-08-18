'use client';

/**
 * The database is a local file that may not have been migrated yet, so the useful error
 * state names the command that fixes the common case instead of apologising.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="min-h-dvh px-4 pb-16">
      <header className="flex items-baseline gap-6 border-b border-rule py-2">
        <h1 className="w-wide text-[13px] font-medium">Worky</h1>
        <span className="w-wide text-[11px] text-fg-dim">error</span>
      </header>
      <div className="prose max-w-lg py-12">
        <p>Could not read the postings database.</p>
        <p className="mt-3">
          If this is a fresh checkout, run{' '}
          <code className="border border-rule bg-surface px-1 py-px text-fg">npm run db:migrate</code>{' '}
          and then{' '}
          <code className="border border-rule bg-surface px-1 py-px text-fg">npm run seed</code>.
        </p>
        {error.digest ? <p className="mt-3">Digest {error.digest}.</p> : null}
        <button type="button" className="chip mt-4" onClick={reset}>
          retry
        </button>
      </div>
    </main>
  );
}
