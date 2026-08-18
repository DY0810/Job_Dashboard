/**
 * The URL *is* the state. Tab, every filter, and the open drawer are search params, so the
 * back button, bookmarking and "send me that filter set" all work without a client store.
 *
 * Search params are a trust boundary even on localhost — everything here is Zod-validated,
 * and anything that does not validate is dropped rather than thrown, because a hand-mangled
 * URL should show the unfiltered table, not an error page.
 */

import { z } from 'zod';

export const TABS = ['design', 'engineering'] as const;
export type Tab = (typeof TABS)[number];
export const DEFAULT_TAB: Tab = 'design';

/** Only these three are ever visible. `senior+` has no option and no row, on either tab. */
export const VISIBLE_SENIORITY = ['entry', 'junior', 'mid'] as const;

export const WINDOW_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Per-tab filter vocabulary, straight from the spec. The Design tab deliberately offers one
 * posted-window (`week`) and no seasons; Engineering offers four windows and no
 * freelance/part-time. A value outside its tab's vocabulary is dropped by `parseParams`.
 */
export const VOCAB = {
  design: {
    posted: ['week'],
    type: ['full-time', 'freelance', 'part-time', 'internship'],
    season: [],
  },
  engineering: {
    posted: ['hour', 'day', 'week', 'month'],
    type: ['full-time', 'internship'],
    season: ['summer', 'fall', 'winter', 'spring'],
  },
} as const satisfies Record<Tab, { posted: readonly string[]; type: readonly string[]; season: readonly string[] }>;

/** Shared by both tabs. `entry` folds into the `junior` option (finding F) — no entry option. */
export const SHARED_VOCAB = {
  pay: ['paid', 'unpaid'],
  mode: ['remote', 'hybrid', 'onsite'],
  level: ['junior', 'mid'],
} as const;

/** The groups a row badge can belong to. */
export const GROUPS = ['type', 'pay', 'mode', 'season', 'level'] as const;
export type Group = (typeof GROUPS)[number];

/** Every filter with a fixed vocabulary — one dropdown each, in this order. `badge` is not
 *  here: it is a free slug off a posting, so it has no list to choose from. */
export const FILTERS = ['posted', ...GROUPS] as const;
export type Filter = (typeof FILTERS)[number];

/**
 * Which vocabulary a filter offers on a tab. The one place that routing is written — the
 * dropdowns, the row badges and the tests all read it here, so a filter cannot offer the
 * dropdown one list and the badge another.
 */
export function vocab(tab: Tab, filter: Filter): readonly string[] {
  return filter === 'posted' || filter === 'type' || filter === 'season'
    ? VOCAB[tab][filter]
    : SHARED_VOCAB[filter];
}

/**
 * One value per filter, or null for "any" — which is exactly what one dropdown can show, so
 * the control and the URL can never disagree about what is on.
 */
export interface Params {
  tab: Tab;
  posted: keyof typeof WINDOW_MS | null;
  type: string | null;
  pay: string | null;
  mode: string | null;
  season: string | null;
  level: string | null;
  /** One free badge slug from `postings.badges`, e.g. `voice-ai`. */
  badge: string | null;
  /** The posting whose drawer is open, from `?job=<id>`. */
  job: number | null;
}

const value = z.string().max(200).optional();

const Raw = z.object({
  tab: z.enum(TABS).catch(DEFAULT_TAB),
  posted: value.catch(undefined),
  type: value.catch(undefined),
  pay: value.catch(undefined),
  mode: value.catch(undefined),
  season: value.catch(undefined),
  level: value.catch(undefined),
  badge: z.string().regex(/^[a-z0-9-]{1,32}$/).optional().catch(undefined),
  job: z
    .preprocess((v) => (v === undefined || v === '' ? undefined : v), z.coerce.number().int().positive().optional())
    .catch(undefined),
});

/** Next hands repeated params through as arrays; the first one wins. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * A URL bookmarked before the filters became dropdowns can still carry a comma list. Take the
 * first value it offers that this tab knows, because one is all a dropdown can show — dropping
 * the rest silently beats a control that misreports the filter it is applying.
 */
function pick(raw: string | undefined, allowed: readonly string[]): string | null {
  return raw ? (raw.split(',').find((v) => allowed.includes(v)) ?? null) : null;
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function parseParams(input: RawSearchParams): Params {
  const raw = Raw.parse({
    tab: first(input.tab),
    posted: first(input.posted),
    type: first(input.type),
    pay: first(input.pay),
    mode: first(input.mode),
    season: first(input.season),
    level: first(input.level),
    badge: first(input.badge),
    job: first(input.job),
  });
  const chosen = Object.fromEntries(
    FILTERS.map((filter) => [filter, pick(raw[filter], vocab(raw.tab, filter))]),
  ) as Record<Filter, string | null>;
  return {
    ...chosen,
    tab: raw.tab,
    posted: chosen.posted as Params['posted'],
    badge: raw.badge ?? null,
    job: raw.job ?? null,
  };
}

export function hasFilters(p: Params): boolean {
  return p.badge !== null || FILTERS.some((filter) => p[filter] !== null);
}

/** Serializes state back to a URL. Unset filters are omitted, so a bare tab stays a bare URL. */
export function href(p: Params): string {
  const q = new URLSearchParams();
  if (p.tab !== DEFAULT_TAB) q.set('tab', p.tab);
  for (const filter of FILTERS) if (p[filter]) q.set(filter, p[filter]!);
  if (p.badge) q.set('badge', p.badge);
  if (p.job !== null) q.set('job', String(p.job));
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

/**
 * The one writer. `null` clears; anything else is validated against the tab's vocabulary on
 * the way out, so a filter link cannot carry a value the tab does not offer.
 *
 * It does not toggle. Toggling is written at the call site — `withFilter(p, g, p[g] === v ?
 * null : v)` — because a badge toggles and a dropdown does not, and burying that difference
 * inside a name is how you get two same-shaped writers with opposite contracts.
 */
export function withFilter(p: Params, filter: Filter | 'badge', value: string | null): string {
  return href(parseParams({ ...toRaw(p), [filter]: value ?? '' }));
}

/** Switching tabs drops filters whose vocabulary does not exist on the destination tab. */
export function withTab(p: Params, tab: Tab): string {
  return href(parseParams({ ...toRaw(p), tab }));
}

export function cleared(p: Params): string {
  return href({ ...p, ...Object.fromEntries(FILTERS.map((f) => [f, null])), badge: null, job: null } as Params);
}

export function withJob(p: Params, job: number | null): string {
  return href({ ...p, job });
}

/** Note the missing `job`: changing a filter closes the drawer — filtering is a table action. */
function toRaw(p: Params): RawSearchParams {
  return {
    tab: p.tab,
    ...Object.fromEntries(FILTERS.map((filter) => [filter, p[filter] ?? undefined])),
    badge: p.badge ?? undefined,
  };
}
