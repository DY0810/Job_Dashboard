'use client';

import { useEffect, useState } from 'react';
import { APPLIED_EVENT, appliedKey, readApplied, saveApplied } from './board-storage';

// One request per page for every row; switching applicant reloads the page.
let ownerRequest: Promise<string | null> | undefined;
const activeOwner = () => ownerRequest ??= fetch('/api/auth/applicant', { credentials: 'same-origin', cache: 'no-store' })
  .then(async (response) => response.ok ? (await response.json() as { ownerId: string }).ownerId : null)
  .catch(() => null);

export function AppliedCheckbox({
  postingId, title, company, compact = false,
}: {
  postingId: number;
  title: string;
  company: string;
  compact?: boolean;
}) {
  const [applied, setApplied] = useState(false);
  const [owner, setOwner] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let current: string | null = null;
    let live = true;
    const update = () => setApplied(readApplied(postingId, current));
    const storage = (event: StorageEvent) => {
      if (event.key === null || event.key === appliedKey(postingId, current)) update();
    };
    const changed = (event: Event) => {
      // No detail (null): the sync moved old checks, so every row re-reads.
      const detail = (event as CustomEvent<number | null>).detail;
      if (detail == null || detail === postingId) update();
    };
    void activeOwner().then((resolved) => {
      if (!live) return;
      current = resolved;
      setOwner(resolved);
      update();
      setReady(true);
    });
    window.addEventListener('storage', storage);
    window.addEventListener(APPLIED_EVENT, changed);
    return () => {
      live = false;
      window.removeEventListener('storage', storage);
      window.removeEventListener(APPLIED_EVENT, changed);
    };
  }, [postingId]);

  return (
    <span className="inline-flex items-center gap-1">
      <label
        className="inline-flex cursor-pointer items-center gap-2 text-[11px]"
        title="Saved in this browser. When you are signed in, auto-apply also skips this job."
      >
        <input
          type="checkbox"
          className="h-4 w-4 cursor-pointer accent-[var(--fg)]"
          aria-label={`Applied to ${title} at ${company}`}
          checked={applied}
          disabled={!ready}
          onChange={(event) => {
            const next = event.currentTarget.checked;
            const saved = saveApplied(postingId, next, owner);
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
