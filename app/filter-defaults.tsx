'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { FILTERS, href, parseParams, type Params } from '@/lib/params';
import { defaultFiltersHref, readDefaultFilters, saveDefaultFilters } from './board-storage';

export function FilterDefaults({ p }: { p: Params }) {
  const router = useRouter();
  const current = href(p);
  const [saved, setSaved] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    const defaults = readDefaultFilters();
    setSaved(defaults);
    setNotice(null);
    const params = parseParams(Object.fromEntries(new URLSearchParams(current.split('?')[1])));
    const next = defaultFiltersHref(params, defaults);
    if (next) router.replace(next, { scroll: false });
  }, [current, router]);

  return (
    <>
      <button
        type="button"
        className="chip"
        title="Save these filters as the default for this browser"
        onClick={(event) => {
          const form = event.currentTarget.closest('form');
          const values = form ? new FormData(form) : null;
          const chosen = values ? parseParams({
            tab: p.tab,
            basis: p.basis ?? undefined,
            ...Object.fromEntries([...FILTERS, 'badge'].map((key) => [key, values.getAll(key).map(String)])),
          }) : p;
          const ok = saveDefaultFilters(chosen);
          setSaved(readDefaultFilters());
          setNotice(ok ? 'defaults saved' : 'defaults not saved: browser storage unavailable');
        }}
      >
        save defaults
      </button>
      {saved !== null ? (
        <button
          type="button"
          className="chip"
          title="Apply the filters saved in this browser"
          onClick={() => {
            const next = defaultFiltersHref(p, saved, true);
            if (next) router.push(next, { scroll: false });
          }}
        >
          my defaults
        </button>
      ) : null}
      {notice ? <span role="status" className="text-[11px] text-fg-dim">{notice}</span> : null}
    </>
  );
}
