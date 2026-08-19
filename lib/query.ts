/**
 * Every filter and the sort, compiled to SQL. Sorting in the database rather than in JS is
 * what keeps the page a single round trip and the row cap honest.
 *
 * Both tabs sort the same way — newest first, entry/junior above mid. The tabs differ in one
 * place only: Design shows the target locations and Engineering shows every location, and
 * that difference lives in `visible()` with the other rules that hold on every route in.
 */

import { and, asc, count, desc, eq, gte, inArray, isNull, like, sql, type SQL } from 'drizzle-orm';
import { cutoffTimestamp } from './dedupe.ts';
import { driver, type ReadDb } from './db/index.ts';
import { postings } from './db/schema.ts';
import { GEO_TIER } from './geo.ts';
import { DESIGN_TYPE, VISIBLE_SENIORITY, WINDOW_MS, bare, type Params } from './params.ts';

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

/**
 * `geoTier()` in SQL. Every tier number, the metro list and the state code are read from
 * `GEO_TIER`, so it stays the single editable constant, and `query.test.ts` cross-checks this
 * expression against `geoTier()` over the whole fixture corpus — which is the only reason it
 * is exported — so the two cannot drift apart silently. Both sides compare `city_norm` exactly,
 * against the same keys, so neither has a matching rule of its own to get wrong.
 *
 * `coalesce` on `work_mode` rather than a bare `=`: SQL three-valued logic would turn a NULL
 * work_mode into a NULL branch condition, which is not the same as "no".
 */
export const geoTierSql: SQL<number> = sql<number>`(case
  when ${postings.cityNorm} in (${sql.join(
    GEO_TIER.metros.map((alias) => sql`${alias}`),
    sql`, `,
  )}) then ${GEO_TIER.metro}
  when ${postings.state} = ${GEO_TIER.californiaCode} then ${GEO_TIER.california}
  when ${postings.isRemote} = 1 or coalesce(${postings.workMode}, '') = 'remote'
    then ${GEO_TIER.remote}
  when ${postings.cityNorm} is null and ${postings.state} is null and ${postings.country} is null
    then ${GEO_TIER.unknown}
  else ${GEO_TIER.elsewhere} end)`;

/** The Design tab's one exclusion, written once. `visible()` negates it; the counter that
 *  explains an empty table asserts it, so the two cannot describe different sets. */
const outsideTargets: SQL = sql`${geoTierSql} = ${GEO_TIER.elsewhere}`;

/**
 * The two sides of the Design split, built from `DESIGN_TYPE` so the SQL and the dropdown
 * vocabulary cannot disagree about which types are freelance.
 *
 * `coalesce` on the employed side is the whole reason this is not one negated expression: a
 * posting whose employment type was never determined is NULL, `NULL not in (...)` answers NULL,
 * and the row would then belong to neither side and vanish from the tab entirely. Unknown is
 * not freelance, so it belongs with the employed rows — and today that is 18 of ~58 Design
 * postings, not an edge case.
 */
const freelanceTypes: SQL = sql.join(
  DESIGN_TYPE.freelance.map((type) => sql`${type}`),
  sql`, `,
);
const isFreelance: SQL = sql`${postings.employmentType} in (${freelanceTypes})`;
const isEmployed: SQL = sql`coalesce(${postings.employmentType}, '') not in (${freelanceTypes})`;

/**
 * Sort key 2 on both tabs: entry and junior above mid. Entry outranks junior too — the spec
 * only pins both above mid, and a total order beats an arbitrary one. Unchanged by entry
 * getting its own filter option: they were always separate here, only the filter folded them.
 */
const seniorityRank = sql<number>`(case ${postings.seniority}
  when 'entry' then 0 when 'junior' then 1 when 'mid' then 2 else 3 end)`;

/** The rules that hold whatever the tab and whatever the filters. */
function structural(now: number): SQL[] {
  return [
    gte(postings.postedAt, new Date(cutoffTimestamp(now))),
    isNull(postings.delistedAt),
    inArray(postings.seniority, [...VISIBLE_SENIORITY]),
  ];
}

/**
 * Structural visibility — not filters, and not negotiable. The 60-day cutoff, delisting, the
 * seniority ceiling and Design's location rule apply to every way into a posting, including
 * the `?job=<id>` deep link: a bookmarked drawer must not resurrect a delisted role, a
 * `senior+` one, or a Design posting the Design table refuses to list.
 *
 * The location rule is written against `track` rather than against the requested tab, so it
 * holds in `getPostingDetail`, which has no tab. `is not` rather than `<>`: a posting with no
 * track yet is not a Design posting, and `<>` would answer NULL and hide it.
 */
function visible(now: number): SQL[] {
  return [...structural(now), sql`(${postings.track} is not 'design' or not ${outsideTargets})`];
}

/** What the reader asked for, as opposed to what they are allowed to see. */
function userFilters(p: Params, now: number): SQL[] {
  const parts: (SQL | undefined)[] = [];

  if (p.posted) parts.push(gte(postings.postedAt, new Date(now - WINDOW_MS[p.posted])));
  if (p.type) parts.push(eq(postings.employmentType, p.type as never));
  if (p.mode) parts.push(eq(postings.workMode, p.mode as never));
  if (p.season) parts.push(eq(postings.internshipSeason, p.season as never));

  // `paid = NULL` is "unknown": it matches neither value, but stays visible while the filter
  // is off (finding G). SQL NULL is not equal to anything, so `eq` already does that.
  if (p.pay) parts.push(eq(postings.paid, p.pay === 'paid'));

  // One option, one value. `entry` used to fold into `junior` here; it is its own option now,
  // so `junior` means junior and nothing else.
  if (p.level) parts.push(eq(postings.seniority, p.level as never));

  // The Design split. Not reachable on Engineering — `parseParams` nulls `basis` there.
  if (p.basis) parts.push(p.basis === 'freelance' ? isFreelance : isEmployed);

  // ponytail: substring match on the JSON array text. Badge slugs are `[a-z0-9-]+` (enforced
  // in params.ts) so they cannot contain a quote and cannot partially match another slug.
  // Swap for `json_each` if badges ever hold arbitrary text.
  if (p.badge) parts.push(like(sql`${postings.badges}`, `%"${p.badge}"%`));

  return parts.filter((part) => part !== undefined);
}

function where(p: Params, now: number): SQL {
  return and(eq(postings.track, p.tab), ...visible(now), ...userFilters(p, now))!;
}

/**
 * Recency first, then seniority — the same two keys on both tabs. There is no last-24h bucket
 * key: `posted_at desc` already puts the newest on top, so a bucket above it changed nothing.
 * The page's "last 24 hours" band depends on this being the first key, and `query.test.ts`
 * asserts that the fresh rows come back as a prefix.
 */
export async function listPostings(db: ReadDb, p: Params, now: number = Date.now()) {
  return await driver(db)
    .select(ROW)
    .from(postings)
    .where(where(p, now))
    .orderBy(desc(postings.postedAt), asc(seniorityRank))
    .all();
}

export type Row = Awaited<ReturnType<typeof listPostings>>[number];

/** True when the tab holds no rows at all — the difference between "empty" and "no matches". */
export async function tabIsEmpty(db: ReadDb, p: Params, now: number = Date.now()): Promise<boolean> {
  const rows = await driver(db)
    .select({ id: postings.id })
    .from(postings)
    .where(where(bare(p), now))
    .limit(1)
    .all();
  return rows.length === 0;
}

/**
 * How many postings these params would have matched but for the location rule. Design's rule
 * is not a filter — it is not in `Params`, so `clear` cannot lift it — which means an empty
 * table has to be able to say that geography is why, rather than blaming the ingest. It counts
 * under the same filters it is explaining, so the number is an answer to the question the
 * reader just asked rather than a fact about the whole tab.
 */
export async function outsideTargetLocations(
  db: ReadDb,
  p: Params,
  now: number = Date.now(),
): Promise<number> {
  const row = await driver(db)
    .select({ n: count() })
    .from(postings)
    .where(and(eq(postings.track, p.tab), ...structural(now), ...userFilters(p, now), outsideTargets))
    .get();
  return row?.n ?? 0;
}

/** Drawer-only fields. The one route handler serves exactly this shape. */
export async function getPostingDetail(db: ReadDb, id: number, now: number = Date.now()) {
  return (
    (await driver(db)
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
      .get()) ?? null
  );
}

export type PostingDetail = NonNullable<Awaited<ReturnType<typeof getPostingDetail>>>;
