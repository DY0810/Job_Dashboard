import { FILTERS, hasFilters, href, parseParams, type Params } from '../lib/params';

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const DEFAULTS_KEY = 'workie-default-filters';
export const APPLIED_EVENT = 'workie-applied-change';
export const appliedKey = (id: number) => `workie-applied:${id}`;

function localStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readApplied(id: number, store: Store | null = localStore()): boolean {
  try {
    return store?.getItem(appliedKey(id)) === '1';
  } catch {
    return false;
  }
}

export function saveApplied(id: number, applied: boolean, store: Store | null = localStore()): boolean {
  try {
    if (!store) return false;
    if (applied) store.setItem(appliedKey(id), '1');
    else store.removeItem(appliedKey(id));
    return true;
  } catch {
    return false;
  }
}

export function readDefaultFilters(store: Store | null = localStore()): string | null {
  try {
    const value = store?.getItem(DEFAULTS_KEY);
    return value !== undefined && value !== null && value.length <= 2000 ? value : null;
  } catch {
    return null;
  }
}

export function saveDefaultFilters(p: Params, store: Store | null = localStore()): boolean {
  try {
    if (!store) return false;
    const query = new URLSearchParams(href(p).split('?')[1]);
    const defaults = new URLSearchParams();
    for (const key of [...FILTERS, 'badge']) {
      const value = query.get(key);
      if (value) defaults.set(key, value);
    }
    store.setItem(DEFAULTS_KEY, defaults.toString());
    return true;
  } catch {
    return false;
  }
}

/** Defaults only fill a bare landing URL; an explicit filter set always wins. */
export function defaultFiltersHref(p: Params, saved: string | null, force = false): string | null {
  if (saved === null || saved.length > 2000) return null;
  if (!force && (hasFilters(p) || p.unfiltered || p.page > 1)) return null;
  const raw = Object.fromEntries(new URLSearchParams(saved));
  const next = parseParams({
    ...Object.fromEntries([...FILTERS, 'badge'].map((key) => [key, raw[key]])),
    tab: p.tab,
    basis: p.basis ?? undefined,
    job: p.job === null ? undefined : String(p.job),
  });
  if (!hasFilters(next) && !force) return null;
  if (force && !hasFilters(next)) next.unfiltered = true;
  return href(next) === href(p) ? null : href(next);
}
