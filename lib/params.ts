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

/** Only these three are ever visible. `senior+` has no chip and no row, on either tab. */
export const VISIBLE_SENIORITY = ['entry', 'junior', 'mid'] as const;

export const WINDOW_MS = {
  hour: 60 * 60 * 1000,
  day: 24 * 60 * 60 * 1000,
  week: 7 * 24 * 60 * 60 * 1000,
  month: 30 * 24 * 60 * 60 * 1000,
} as const;

/**
 * Per-tab filter vocabulary, straight from the spec. The Design tab deliberately offers one
 * posted-window (`week`) and no season chips; Engineering offers four windows and no
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

/** Shared by both tabs. `entry` folds into the `junior` chip (finding F) — there is no entry chip. */
export const SHARED_VOCAB = {
  pay: ['paid', 'unpaid'],
  mode: ['remote', 'hybrid', 'onsite'],
  level: ['junior', 'mid'],
} as const;

/** The multi-select groups: OR inside a group, AND across groups. */
export const GROUPS = ['type', 'pay', 'mode', 'season', 'level'] as const;
export type Group = (typeof GROUPS)[number];

export interface Params {
  tab: Tab;
  /** Single-select: the posted-within window, or null for "any time". */
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

const csv = z.string().max(200).optional();

const Raw = z.object({
  tab: z.enum(TABS).catch(DEFAULT_TAB),
  posted: csv.catch(undefined),
  type: csv.catch(undefined),
  pay: csv.catch(undefined),
  mode: csv.catch(undefined),
  season: csv.catch(undefined),
  level: csv.catch(undefined),
  badge: z.string().regex(/^[a-z0-9-]{1,32}$/).optional().catch(undefined),
  job: z
    .preprocess((v) => (v === undefined || v === '' ? undefined : v), z.coerce.number().int().positive().optional())
    .catch(undefined),
});

/** Next hands repeated params through as arrays; the first one wins. */
function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function pick(raw: string | undefined, allowed: readonly string[]): string[] {
  if (!raw) return [];
  const chosen = raw.split(',').filter((v) => allowed.includes(v));
  return allowed.filter((v) => chosen.includes(v)); // canonical order, deduped
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
  const vocab = VOCAB[raw.tab];
  return {
    tab: raw.tab,
    posted: (pick(raw.posted, vocab.posted)[0] as Params['posted']) ?? null,
    type: pick(raw.type, vocab.type),
    pay: pick(raw.pay, SHARED_VOCAB.pay),
    mode: pick(raw.mode, SHARED_VOCAB.mode),
    season: pick(raw.season, vocab.season),
    level: pick(raw.level, SHARED_VOCAB.level),
    badge: raw.badge ?? null,
    job: raw.job ?? null,
  };
}

export function hasFilters(p: Params): boolean {
  return (
    p.posted !== null ||
    p.badge !== null ||
    GROUPS.some((g) => p[g].length > 0)
  );
}

/** Serializes state back to a URL. Empty groups are omitted, so a bare tab stays a bare URL. */
export function href(p: Params): string {
  const q = new URLSearchParams();
  if (p.tab !== DEFAULT_TAB) q.set('tab', p.tab);
  if (p.posted) q.set('posted', p.posted);
  for (const g of GROUPS) if (p[g].length) q.set(g, p[g].join(','));
  if (p.badge) q.set('badge', p.badge);
  if (p.job !== null) q.set('job', String(p.job));
  const s = q.toString();
  return s ? `/?${s}` : '/';
}

/** Toggling a chip never opens or keeps a drawer open — filtering is a table action. */
export function toggle(p: Params, group: Group, value: string): string {
  const on = p[group].includes(value);
  const next = on ? p[group].filter((v) => v !== value) : [...p[group], value];
  return href({ ...p, [group]: next, job: null });
}

export function withPosted(p: Params, value: Params['posted']): string {
  return href({ ...p, posted: p.posted === value ? null : value, job: null });
}

export function withBadge(p: Params, value: string): string {
  return href({ ...p, badge: p.badge === value ? null : value, job: null });
}

/** Switching tabs drops filters whose vocabulary does not exist on the destination tab. */
export function withTab(p: Params, tab: Tab): string {
  return href(parseParams({ ...toRaw(p), tab }));
}

export function cleared(p: Params): string {
  return href({ ...p, posted: null, type: [], pay: [], mode: [], season: [], level: [], badge: null, job: null });
}

export function withJob(p: Params, job: number | null): string {
  return href({ ...p, job });
}

function toRaw(p: Params): RawSearchParams {
  return {
    tab: p.tab,
    posted: p.posted ?? undefined,
    type: p.type.join(','),
    pay: p.pay.join(','),
    mode: p.mode.join(','),
    season: p.season.join(','),
    level: p.level.join(','),
    badge: p.badge ?? undefined,
  };
}
