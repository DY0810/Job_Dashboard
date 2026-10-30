'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { FILTERS, cleared, href, parseParams, type Params } from '@/lib/params';
import { useBoardPush } from './auto-apply';
import {
  defaultFiltersHref,
  filterQuery,
  myFilter,
  readDefaultFilters,
  saveDefaultFilters,
  savedFilterQuery,
  stillEngaged,
  type MyFilter,
} from './board-storage';

const TITLE: Record<MyFilter['action'], string> = {
  setup: 'Choose filters, then save them as yours',
  none: 'Choose filters to save',
  save: 'Save these filters as yours, in this browser',
  apply: 'Apply your saved filter',
  clear: 'Turn your filter off',
};

/** What the form shows right now, which runs ahead of the URL until its debounce submits. */
function selection(form: HTMLFormElement, p: Params): Params {
  const values = new FormData(form);
  return parseParams({
    tab: p.tab,
    basis: p.basis ?? undefined,
    ...Object.fromEntries([...FILTERS, 'badge'].map((key) => [key, values.getAll(key).map(String)])),
  });
}

/**
 * The one saved filter, as one button. The decisions live in `myFilter` (board-storage.ts,
 * tested); this is the wiring: read the saved value, watch the form, act on a click.
 */
export function FilterDefaults({ p }: { p: Params }) {
  const router = useRouter();
  const [, push] = useBoardPush();
  const button = useRef<HTMLButtonElement>(null);
  // The live URL, not `p`: the posting drawer opens and closes in the browser, after the server rendered `p`.
  const current = href(parseParams(Object.fromEntries(useSearchParams())));
  // Null until mounted: storage is per browser, so the server renders the plain button.
  const [stored, setStored] = useState<string | null>(null);
  const [live, setLive] = useState(() => filterQuery(p));
  const [engaged, setEngaged] = useState(false);
  const [setup, setSetup] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const saved = savedFilterQuery(p, stored);

  useEffect(() => {
    const defaults = readDefaultFilters();
    setStored(defaults);
    setNotice(null);
    // A bare landing URL gets the saved filter; an explicit one, or `?filters=all`, never does.
    const params = parseParams(Object.fromEntries(new URLSearchParams(current.split('?')[1])));
    const next = defaultFiltersHref(params, defaults);
    if (next) router.replace(next, { scroll: false });
  }, [current, router]);

  // `change` bubbles from every control, and `AutoApply` fires one after writing a landed URL in.
  useEffect(() => {
    const form = button.current?.closest('form');
    if (!form) return;
    const read = () => setLive(filterQuery(selection(form, p)));
    read();
    form.addEventListener('change', read);
    return () => form.removeEventListener('change', read);
    // `p` only supplies tab and split, both of which are in `current`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  useEffect(() => {
    setEngaged((was) => stillEngaged(was, saved, live));
  }, [saved, live]);

  const state = myFilter({ saved, live, engaged, setup });

  const onClick = () => {
    const form = button.current?.closest('form');
    if (state.action === 'setup') {
      setSetup(true);
    } else if (state.action === 'save' && form) {
      const chosen = selection(form, p);
      if (!saveDefaultFilters(chosen)) {
        setNotice('not saved: browser storage unavailable');
        return;
      }
      setStored(readDefaultFilters());
      setSetup(false);
      setEngaged(true);
      push(href(chosen));
    } else if (state.action === 'apply') {
      const next = defaultFiltersHref(p, stored, true);
      if (next) push(next);
    } else if (state.action === 'clear') {
      // `?filters=all`, so the saved filter does not come straight back on a bare URL.
      push(cleared(p));
    }
  };

  return (
    <>
      <button
        ref={button}
        type="button"
        className="btn"
        aria-pressed={state.pressed}
        aria-disabled={state.action === 'none' ? 'true' : undefined}
        title={TITLE[state.action]}
        onClick={onClick}
      >
        {state.label}
      </button>
      {notice ? <span role="status" className="text-[11px] text-fg-dim">{notice}</span> : null}
    </>
  );
}
