/**
 * Every filter and both sort orders, compiled to SQL. Sorting in the database rather than in
 * JS is what keeps the page a single round trip and the row cap honest.
 *
 * The two tabs differ in one key: Design is geo-weighted, Engineering is not.
 */

import { and, asc, desc, eq, gte, inArray, isNull, like, or, sql, type SQL } from 'drizzle-orm';
import { cutoffTimestamp } from './dedupe';
import type { Db } from './db';
import { postings } from './db/schema';
import { GEO_TIER } from './geo';
import { VISIBLE_SENIORITY, WINDOW_MS, type Params } from './params';

const DAY_MS = WINDOW_MS.day;

/** The table never selects `description` — ~2k full bodies is ~8MB the table cannot use. */
const ROW = {
  id: postings.id,
  postedAt: postings.postedAt,
  company: postings.company,
  title: postings.title,
  summary: postings.summary,
  badges: postings.badges,
  seniority: postings.seniority,
  employmentType: postings.employmentType,
  internshipSeason: postings.internshipSeason,
  paid: postings.paid,
  workMode: postings.workMode,
  location: postings.location,
  payRateMin: postings.payRateMin,
  payRateMax: postings.payRateMax,
  payRatePeriod: postings.payRatePeriod,
  expectedGrad: postings.expectedGrad,
  canonicalUrl: postings.canonicalUrl,
} as const;

/** Sort key 1 on both tabs: 1 for the last-24h band, 0 for everything below it. */
function freshBucket(now: number): SQL<number> {
  return sql<number>`(case when ${postings.postedAt} >= ${now - DAY_MS} then 1 else 0 end)`;
}

/**
 * Sort key 2 on the Design tab only. Mirrors `geoTier()` in SQL — the tier *numbers* and the
 * metro list are read from `GEO_TIER` so it stays the single editable constant, and
 * `query.test.ts` cross-checks this expression against `geoTier()` over the whole fixture
 * corpus — which is the only reason it is exported — so the two cannot drift apart silently.
 */
export function geoRank(): SQL<number> {
  const metros = sql.join(
    GEO_TIER.metros.map((m) => sql`${m}`),
    sql`, `,
  );
  return sql<number>`(case
    when ${postings.cityNorm} in (${metros}) then ${GEO_TIER.metro}
    when ${postings.state} = 'CA' then ${GEO_TIER.california}
    when ${postings.isRemote} = 1 then ${GEO_TIER.remote}
    else ${GEO_TIER.elsewhere} end)`;
}

/**
 * Last sort key on both tabs: entry and junior above mid (finding F). Entry outranks junior
 * too — the spec only pins both above mid, and a total order beats an arbitrary one.
 */
const seniorityRank = sql<number>`(case ${postings.seniority}
  when 'entry' then 0 when 'junior' then 1 when 'mid' then 2 else 3 end)`;

/**
 * Structural visibility — not filters, and not negotiable. The 60-day cutoff, delisting, and
 * the seniority ceiling apply to every way into a posting, including the `?job=<id>` deep
 * link: a bookmarked drawer must not resurrect a delisted role or a `senior+` one.
 */
function visible(now: number): SQL[] {
  return [
    gte(postings.postedAt, new Date(cutoffTimestamp(now))),
    isNull(postings.delistedAt),
    inArray(postings.seniority, [...VISIBLE_SENIORITY]),
  ];
}

function where(p: Params, now: number): SQL {
  const parts: (SQL | undefined)[] = [eq(postings.track, p.tab), ...visible(now)];

  if (p.posted) parts.push(gte(postings.postedAt, new Date(now - WINDOW_MS[p.posted])));
  if (p.type.length) parts.push(inArray(postings.employmentType, p.type as never[]));
  if (p.mode.length) parts.push(inArray(postings.workMode, p.mode as never[]));
  if (p.season.length) parts.push(inArray(postings.internshipSeason, p.season as never[]));

  // `paid = NULL` is "unknown": it matches neither chip, but stays visible with no chip on
  // (finding G). `inArray` cannot express that — SQL NULL is not equal to anything.
  if (p.pay.length) {
    parts.push(or(...p.pay.map((v) => eq(postings.paid, v === 'paid'))));
  }

  // `junior` covers entry as well; there is no entry chip.
  if (p.level.length) {
    const wanted = p.level.flatMap((v) => (v === 'junior' ? ['entry', 'junior'] : [v]));
    parts.push(inArray(postings.seniority, wanted as never[]));
  }

  // ponytail: substring match on the JSON array text. Badge slugs are `[a-z0-9-]+` (enforced
  // in params.ts) so they cannot contain a quote and cannot partially match another slug.
  // Swap for `json_each` if badges ever hold arbitrary text.
  if (p.badge) parts.push(like(sql`${postings.badges}`, `%"${p.badge}"%`));

  return and(...parts)!;
}

function orderBy(p: Params, now: number) {
  const fresh = desc(freshBucket(now));
  return p.tab === 'design'
    ? [fresh, asc(geoRank()), desc(postings.postedAt), asc(seniorityRank)]
    : [fresh, desc(postings.postedAt), asc(seniorityRank)];
}

export function listPostings(db: Db, p: Params, now: number = Date.now()) {
  return db.select(ROW).from(postings).where(where(p, now)).orderBy(...orderBy(p, now)).all();
}

export type Row = ReturnType<typeof listPostings>[number];

/** True when the tab holds no rows at all — the difference between "empty" and "no matches". */
export function tabIsEmpty(db: Db, p: Params, now: number = Date.now()): boolean {
  const bare: Params = { ...p, posted: null, type: [], pay: [], mode: [], season: [], level: [], badge: null };
  return db.select({ id: postings.id }).from(postings).where(where(bare, now)).limit(1).all().length === 0;
}

/** Drawer-only fields. The one route handler serves exactly this shape. */
export function getPostingDetail(db: Db, id: number, now: number = Date.now()) {
  return (
    db
      .select({
        id: postings.id,
        title: postings.title,
        company: postings.company,
        location: postings.location,
        isRemote: postings.isRemote,
        description: postings.description,
        responsibilities: postings.responsibilities,
        skills: postings.skills,
        education: postings.education,
        canonicalUrl: postings.canonicalUrl,
      })
      .from(postings)
      .where(and(eq(postings.id, id), ...visible(now)))
      .get() ?? null
  );
}

export type PostingDetail = NonNullable<ReturnType<typeof getPostingDetail>>;
