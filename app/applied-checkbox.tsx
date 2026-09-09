'use client';

import { useEffect, useState } from 'react';
import { APPLIED_EVENT, appliedKey, readApplied, saveApplied } from './board-storage';

export function AppliedCheckbox({
  postingId, title, company, compact = false,
}: {
  postingId: number;
  title: string;
  company: string;
  compact?: boolean;
}) {
  const [applied, setApplied] = useState(false);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    const update = () => setApplied(readApplied(postingId));
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === appliedKey(postingId)) update();
    };
    const changed = (event: Event) => {
      if ((event as CustomEvent<number>).detail === postingId) update();
    };
    update();
    setReady(true);
    window.addEventListener('storage', storage);
    window.addEventListener(APPLIED_EVENT, changed);
    return () => {
      window.removeEventListener('storage', storage);
      window.removeEventListener(APPLIED_EVENT, changed);
    };
  }, [postingId]);

  return (
    <span className="inline-flex items-center gap-1">
      <label
        className="inline-flex cursor-pointer items-center gap-2 text-[11px]"
        title="Application status saved only in this browser"
      >
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-[var(--fg)]"
          aria-label={`Applied to ${title} at ${company}`}
          checked={applied}
          disabled={!ready}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            const saved = saveApplied(postingId, next);
            setError(!saved);
            if (!saved) return;
            setApplied(next);
            window.dispatchEvent(new CustomEvent(APPLIED_EVENT, { detail: postingId }));
          }}
        />
        <span className={compact ? 'sr-only' : undefined}>applied</span>
      </label>
      {error ? (
        <span role="alert" title="Not saved. Browser storage is unavailable.">
          <span aria-hidden="true">!</span>
          <span className="sr-only">Not saved. Browser storage is unavailable.</span>
        </span>
      ) : null}
    </span>
  );
}
