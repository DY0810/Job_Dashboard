import { FILTERS, hasFilters, href, parseParams, type Params } from '../lib/params';
import { del, get, localStore, set, type Store } from './local-store';

const DEFAULTS_KEY = 'workie-default-filters';
export const APPLIED_EVENT = 'workie-applied-change';
/** Signed in, a check belongs to the applicant who made it; signed out it stays in this browser only. */
export const appliedKey = (id: number, owner: string | null = null) =>
  owner ? `workie-applied:${owner}:${id}` : `workie-applied:${id}`;

// One request per page for every row; switching applicant reloads the page. Only 401 means signed out:
// any other failure is forgotten so a later mount retries, rather than saving a signed-in tick unscoped.
let ownerRequest: Promise<string | null> | undefined;
export const activeOwner = () => ownerRequest ??= fetch('/api/auth/applicant',
  { credentials: 'same-origin', cache: 'no-store', redirect: 'error' })
  .then(async (response) => {
    if (response.status === 401) return null;
    if (!response.ok) throw new Error(`applicant lookup ${response.status}`);
    return (await response.json() as { ownerId: string }).ownerId;
  })
  .catch((error: unknown) => { ownerRequest = undefined; throw error; });

export function readApplied(id: number, owner: string | null, store: Store | null = localStore()): boolean {
  return get(appliedKey(id, owner), store) === '1';
}

export function saveApplied(id: number, applied: boolean, owner: string | null, store: Store | null = localStore()): boolean {
  return applied ? set(appliedKey(id, owner), '1', store) : del(appliedKey(id, owner), store);
}

export function readDefaultFilters(store: Store | null = localStore()): string | null {
  const value = get(DEFAULTS_KEY, store);
  return value !== null && value.length <= 2000 ? value : null;
}

/** Just the filters of `p`, canonical, so two selections compare as strings. Tab, split, drawer and page are not part of it. */
export function filterQuery(p: Params): string {
  const query = new URLSearchParams(href(p).split('?')[1]);
  const filters = new URLSearchParams();
  for (const key of [...FILTERS, 'badge']) {
    const value = query.get(key);
    if (value) filters.set(key, value);
  }
  return filters.toString();
}

export function saveDefaultFilters(p: Params, store: Store | null = localStore()): boolean {
  return set(DEFAULTS_KEY, filterQuery(p), store);
}

/** The saved filter as it applies on `p`'s tab and split: values that side does not offer drop out. */
export function savedFilterQuery(p: Params, saved: string | null): string {
  if (saved === null) return '';
  const raw = Object.fromEntries(new URLSearchParams(saved));
  return filterQuery(parseParams({ ...raw, tab: p.tab, basis: p.basis ?? undefined }));
}

export interface MyFilter {
  label: 'my filter' | 'save filter';
  /** Only a toggle once there is something saved to toggle. */
  pressed?: boolean;
  action: 'setup' | 'save' | 'apply' | 'clear' | 'none';
}

/**
 * The one filter button. `saved` and `live` are `filterQuery` strings ('' = no filters): `live` is
 * what the form shows, which runs ahead of the URL until the debounce submits. `setup` means
 * "my filter" was clicked with nothing saved yet. `engaged` means the saved filter was on and has
 * not been turned off since, which is what separates "you changed my filter" (offer to save)
 * from "some other filter is on" (offer to apply).
 */
export function myFilter({ saved, live, engaged, setup }: { saved: string; live: string; engaged: boolean; setup: boolean }): MyFilter {
  if (!saved) return setup ? { label: 'save filter', action: live ? 'save' : 'none' } : { label: 'my filter', action: 'setup' };
  if (live === saved) return { label: 'my filter', pressed: true, action: 'clear' };
  if (engaged && live) return { label: 'save filter', action: 'save' };
  return { label: 'my filter', pressed: false, action: 'apply' };
}

/** Engaged once the saved filter is showing; disengaged once nothing is selected. */
export function stillEngaged(engaged: boolean, saved: string, live: string): boolean {
  return saved !== '' && live !== '' && (engaged || live === saved);
}

/**
 * Defaults only fill a bare landing URL; an explicit filter set always wins. A landing keeps its
 * drawer; a click (`force`) drops it, since the drawer is modal and so already closed — and `p`
 * can still name a posting that was closed in the browser after the server rendered it.
 */
export function defaultFiltersHref(p: Params, saved: string | null, force = false): string | null {
  if (saved === null || saved.length > 2000) return null;
  if (!force && (hasFilters(p) || p.unfiltered || p.page > 1)) return null;
  const raw = Object.fromEntries(new URLSearchParams(saved));
  const next = parseParams({
    ...Object.fromEntries([...FILTERS, 'badge'].map((key) => [key, raw[key]])),
    tab: p.tab,
    basis: p.basis ?? undefined,
    job: force || p.job === null ? undefined : String(p.job),
  });
  if (!hasFilters(next) && !force) return null;
  if (force && !hasFilters(next)) next.unfiltered = true;
  return href(next) === href(p) ? null : href(next);
}
