'use client';

import { useEffect, useState } from 'react';

export const SEEN_KEY = 'talkie-seen-at';
const WEEK_MS = 7 * 86_400_000;

/**
 * The number in the circle: notes and replies since this device last opened Talkie. Fetched on the
 * client because the job tabs are held at the edge for five minutes, and a count baked into
 * that HTML would be stale by design. A first-time device starts its cursor a week back — "new
 * this week", not "every note ever written".
 */
export function TalkieBadge() {
  const [count, setCount] = useState(0);

  useEffect(() => {
    const since = Number(localStorage.getItem(SEEN_KEY) ?? Date.now() - WEEK_MS);
    fetch(`/api/notes?since=${since}`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { count?: number } | null) => d && setCount(d.count ?? 0))
      .catch(() => {});
  }, []);

  if (count === 0) return null;
  return (
    <span className="badge" aria-label={`${count} new on Talkie`}>
      {count > 99 ? '99+' : count}
    </span>
  );
}
