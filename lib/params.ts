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
 * The Design tab's freelance split. Not a filter: it partitions the tab, so one side is
 * always on and there is no "any". Design defaults to `employed` — the tab's ordinary use —
 * and Engineering has no split at all, so its `basis` is null.
 *
 * `freelance` covers `contract` too. The extractor writes `freelance` only when a posting
 * says the word; the same engagement described as "a 6-month contract role" lands as
 * `contract`, and a split that matched only the literal `freelance` would hide most of it.
 */
export const BASES = ['employed', 'freelance'] as const;
export type Basis = (typeof BASES)[number];
export const DEFAULT_BASIS: Basis = 'employed';

/**
 * The employment types each side of the split owns, and the reason the split needs no new
 * column: it is the same `employment_type` the `type` dropdown filters on, cut in two. Every
 * value the extractor can produce appears on exactly one side, so no posting can fall between
 * them and none can appear on both. `lib/query.ts` builds its SQL from this same constant.
 */
export const DESIGN_TYPE = {
  employed: ['full-time', 'part-time', 'internship'],
  freelance: ['freelance', 'contract'],
} as const satisfies Record<Basis, readonly string[]>;

/**
 * The posted-within windows, shared by both tabs. Design used to offer `week` alone, which
 * read as a broken control: a dropdown with one option cannot narrow anything twice, and the
 * tab next to it had four. Written once so the two cannot drift apart again.
 */
export const POSTED_WINDOWS = ['hour', 'day', 'week', 'month'] as const;

/**
 * Per-tab filter vocabulary, straight from the spec. Design has no seasons; Engineering has no
 * freelance/part-time. A value outside its tab's vocabulary is dropped by `parseParams`.
 *
 * Design's `type` here is the union of both sides of the split — the answer to "does Design
 * filter on type at all". `vocab()` narrows it to the side the reader is actually on.
 */
export const VOCAB = {
  design: {
    posted: POSTED_WINDOWS,
    type: [...DESIGN_TYPE.employed, ...DESIGN_TYPE.freelance],
    season: [],
  },
  engineering: {
    posted: POSTED_WINDOWS,
    type: ['full-time', 'internship'],
    season: ['summer', 'fall', 'winter', 'spring'],
  },
} as const satisfies Record<Tab, { posted: readonly string[]; type: readonly string[]; season: readonly string[] }>;

/**
 * Shared by both tabs. `entry` is its own option on both: classification produces entry and
 * junior as different things, and folding them (the original finding F) meant one chip
 * labelled `junior` silently answered for both — hiding the larger group behind the smaller
 * one's name. They still sort together, above mid.
 */
export const SHARED_VOCAB = {
  pay: ['paid', 'unpaid'],
  mode: ['remote', 'hybrid', 'onsite'],
  level: ['entry', 'junior', 'mid'],
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
 *
 * `basis` narrows Design's `type` to the side of the split being shown, which is what keeps
 * the two controls from contradicting each other: the freelance side cannot offer `full-time`,
 * so no reachable URL asks for a full-time freelance posting and gets an empty table.
 */
export function vocab(tab: Tab, filter: Filter, basis: Basis | null = null): readonly string[] {
  if (tab === 'design' && filter === 'type') return DESIGN_TYPE[basis ?? DEFAULT_BASIS];
  return filter === 'posted' || filter === 'type' || filter === 'season'
    ? VOCAB[tab][filter]
    : SHARED_VOCAB[filter];
}

/**
 * A SET per group filter, and one value for `posted`.
 *
 * The groups are sets because the questions they answer are naturally plural — "entry or
 * junior", "remote or hybrid", "full-time or internship" — and answering them one value at a
 * time made the reader run the same search twice. An empty array is "any", which is the same
 * thing `null` used to mean.
 *
 * `posted` stays single, and that is not an oversight: the windows nest. 24h is inside 7d, so
 * selecting both is selecting 7d, and a control that offers a choice with no distinct outcome
 * is a control that lies. `badge` stays single because it is a free slug off one posting, not a
 * vocabulary anything can enumerate.
 */
export interface Params {
  tab: Tab;
  /** Which side of the Design freelance split. Always set on Design, always null elsewhere. */
  basis: Basis | null;
  posted: keyof typeof WINDOW_MS | null;
  type: string[];
  pay: string[];
  mode: string[];
  season: string[];
  level: string[];
  /** One free badge slug from `postings.badges`, e.g. `voice-ai`. */
  badge: string | null;
  /** The posting whose drawer is open, from `?job=<id>`. */
  job: number | null;
}

const value = z.string().max(200).optional();

const Raw = z.object({
  tab: z.enum(TABS).catch(DEFAULT_TAB),
  basis: z.enum(BASES).optional().catch(undefined),
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

/** Next hands repeated params through as arrays; for a single-valued param the first wins. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * BOTH spellings of a set have to parse, because both are produced. A checkbox group submits
 * its name once per checked box (`?level=entry&level=junior`, which Next hands over as an
 * array), while `href` writes one comma list (`?level=entry,junior`) so a shared URL stays
 * short. Joining first means one parser handles either.
 */
function collect(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value.join(',') : value;
}

/** One value, for `posted` — the first the tab recognizes. */
function pick(raw: string | undefined, allowed: readonly string[]): string | null {
  return raw ? (raw.split(',').find((v) => allowed.includes(v)) ?? null) : null;
}

/**
 * Every value the tab recognizes, deduped, IN VOCABULARY ORDER rather than in the order they
 * arrived. The ordering is what makes the URL canonical: `?level=junior,entry` and
 * `?level=entry,junior` are the same filter and must serialize identically, or the same table
 * has two addresses and `href(parseParams(x))` stops being idempotent.
 */
function pickAll(raw: string | undefined, allowed: readonly string[]): string[] {
  if (!raw) return [];
  const chosen = new Set(raw.split(','));
  return allowed.filter((value) => chosen.has(value));
}

export type RawSearchParams = Record<string, string | string[] | undefined>;

export function parseParams(input: RawSearchParams): Params {
  const raw = Raw.parse({
    tab: first(input.tab),
    basis: first(input.basis),
    posted: first(input.posted),
    type: collect(input.type),
    pay: collect(input.pay),
    mode: collect(input.mode),
    season: collect(input.season),
    level: collect(input.level),
    badge: first(input.badge),
    job: first(input.job),
  });
  // Resolved before the filters, because Design's `type` vocabulary depends on it. A `basis`
  // on an Engineering URL is dropped rather than honoured: the split is a Design control, and
  // carrying it silently would let `?tab=engineering&basis=freelance` filter a tab that shows
  // no such toggle.
  const basis: Basis | null = raw.tab === 'design' ? (raw.basis ?? DEFAULT_BASIS) : null;
  const groups = Object.fromEntries(
    GROUPS.map((group) => [group, pickAll(raw[group], vocab(raw.tab, group, basis))]),
  ) as Record<Group, string[]>;
  return {
    ...groups,
    tab: raw.tab,
    basis,
    posted: pick(raw.posted, vocab(raw.tab, 'posted', basis)) as Params['posted'],
    badge: raw.badge ?? null,
    job: raw.job ?? null,
  };
}

export function hasFilters(p: Params): boolean {
  return p.badge !== null || p.posted !== null || GROUPS.some((group) => p[group].length > 0);
}

/** Serializes state back to a URL. Unset filters are omitted, so a bare tab stays a bare URL. */
export function href(p: Params): string {
  const q = new URLSearchParams();
  if (p.tab !== DEFAULT_TAB) q.set('tab', p.tab);
  // Only the non-default side is written. `employed` is what a bare `/` already means, and
  // spelling it out would give the same table two URLs.
  if (p.basis && p.basis !== DEFAULT_BASIS) q.set('basis', p.basis);
  if (p.posted) q.set('posted', p.posted);
  // One comma list per group rather than a repeated key: both parse, and this is the shorter
  // of the two to paste into a message.
  for (const group of GROUPS) if (p[group].length > 0) q.set(group, p[group].join(','));
  if (p.badge) q.set('badge', p.badge);
  if (p.job !== null) q.set('job', String(p.job));
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

/**
 * Replaces a filter outright. `null` clears it; a value or list is validated against the tab's
 * vocabulary on the way out, so a link cannot carry a value the tab does not offer.
 *
 * Still does not toggle, and the reason is the same as when the filters were single-valued: a
 * badge toggles and a dropdown does not, and hiding that difference inside one name is how you
 * get two same-shaped writers with opposite contracts. Toggling now has its own writer below,
 * because with sets the toggle is no longer expressible at the call site as a ternary.
 */
export function withFilter(
  p: Params,
  filter: Filter | 'badge',
  value: string | readonly string[] | null,
): string {
  const raw: string = value === null ? '' : typeof value === 'string' ? value : value.join(',');
  return href(parseParams({ ...toRaw(p), [filter]: raw }));
}

/**
 * Adds a value to a group, or removes it if it is already there — what a row badge does, and
 * what a checkbox does. This is the writer the multi-select needs: with a set, "the other
 * state" is not a single alternative the call site can name, it is the current set plus or
 * minus one member.
 *
 * The result goes back through `parseParams`, so the new set is re-ordered into vocabulary
 * order and re-validated against the tab. Toggling a value the tab does not offer is therefore
 * a no-op rather than a URL that filters on something invisible.
 */
export function toggleFilter(p: Params, group: Group, value: string): string {
  const current = p[group];
  const next = current.includes(value)
    ? current.filter((existing) => existing !== value)
    : [...current, value];
  return withFilter(p, group, next);
}

/** Switching tabs drops filters whose vocabulary does not exist on the destination tab. */
export function withTab(p: Params, tab: Tab): string {
  return href(parseParams({ ...toRaw(p), tab }));
}

/**
 * Crossing the Design split. Routed through `parseParams` for the same reason `withTab` is:
 * the destination side owns a different `type` vocabulary, so a `type` the new side does not
 * offer is dropped on the way rather than carried into a table that cannot show it.
 */
export function withBasis(p: Params, basis: Basis): string {
  return href(parseParams({ ...toRaw(p), basis }));
}

/** The same params with every filter off — what `clear` navigates to, and what the "is this
 *  tab empty at all?" probe asks about. Derived from `FILTERS` so a new filter cannot be
 *  missed by one of the two. `basis` deliberately survives: it is not a filter, and clearing
 *  filters should not also walk you across the split. */
export function bare(p: Params): Params {
  return {
    ...p,
    posted: null,
    ...(Object.fromEntries(GROUPS.map((group) => [group, [] as string[]])) as Record<Group, string[]>),
    badge: null,
  };
}

export function cleared(p: Params): string {
  return href({ ...bare(p), job: null });
}

export function withJob(p: Params, job: number | null): string {
  return href({ ...p, job });
}

/** Note the missing `job`: changing a filter closes the drawer — filtering is a table action. */
function toRaw(p: Params): RawSearchParams {
  return {
    tab: p.tab,
    basis: p.basis ?? undefined,
    posted: p.posted ?? undefined,
    ...Object.fromEntries(
      GROUPS.map((group) => [group, p[group].length > 0 ? p[group].join(',') : undefined]),
    ),
    badge: p.badge ?? undefined,
  };
}
