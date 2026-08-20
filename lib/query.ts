/**
 * Every filter and the sort, compiled to SQL. Sorting in the database rather than in JS is
 * what keeps the page a single round trip and the row cap honest.
 *
 * Both tabs sort the same way — newest first, entry/junior above mid. The tabs differ in one
 * place only: Design shows the target locations and Engineering shows every US location, and
 * that difference lives in `visible()` with the other rules that hold on every route in.
 * Neither tab shows a job that is onsite in another country.
 */

import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, like, sql, type SQL } from 'drizzle-orm';
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
/**
 * Remote by either signal, written once because two rules read it: the `remote` tier below,
 * and the foreign-onsite exclusion further down. `coalesce` rather than a bare `=`: SQL
 * three-valued logic would turn a NULL `work_mode` into a NULL condition, which is not "no".
 */
const isRemoteSql: SQL = sql`(${postings.isRemote} = 1 or coalesce(${postings.workMode}, '') = 'remote')`;

export const geoTierSql: SQL<number> = sql<number>`(case
  when ${postings.cityNorm} in (${sql.join(
    GEO_TIER.metros.map((alias) => sql`${alias}`),
    sql`, `,
  )}) then ${GEO_TIER.metro}
  when ${postings.state} = ${GEO_TIER.californiaCode} then ${GEO_TIER.california}
  when ${isRemoteSql} then ${GEO_TIER.remote}
  when ${postings.cityNorm} is null and ${postings.state} is null and ${postings.country} is null
    then ${GEO_TIER.unknown}
  else ${GEO_TIER.elsewhere} end)`;

/** The Design tab's one exclusion, written once. `visible()` negates it; the counter that
 *  explains an empty table asserts it, so the two cannot describe different sets. */
const outsideTargets: SQL = sql`${geoTierSql} = ${GEO_TIER.elsewhere}`;

/**
 * Onsite in another country — the rows nobody reading this can take. Remote abroad is fine and
 * stays: a remote job posted from Warsaw is a job you can do from here, which is why this asks
 * for `not remote` rather than leaning on the geo tier. It cannot be a tier for the same
 * reason: `remote` is decided before country upstream in `geoTier`, so a foreign remote row is
 * already tier `remote`, and a foreign onsite row lands in `elsewhere` next to Austin.
 *
 * `country is not null` carries weight: an unparsed location is a missing-data problem, not
 * evidence of being abroad, and `<>` against NULL would answer NULL and hide the row anyway.
 */
const foreignOnsite: SQL = sql`(${postings.country} is not null
  and ${postings.country} <> ${GEO_TIER.usCode}
  and not ${isRemoteSql})`;

/**
 * Every row the location rules hide, per track, in one expression — `visible()` negates it and
 * `outsideTargetLocations` asserts it, so the table and the number explaining an empty table
 * cannot disagree. Design hides all of `elsewhere`, which already contains every foreign onsite
 * row; every other track hides only the foreign onsite ones, because `elsewhere` is also where
 * Austin and Chicago live and Engineering is not a targeted-metro tab.
 */
const hiddenByLocation: SQL = sql`(${foreignOnsite}
  or (${postings.track} is 'design' and ${outsideTargets}))`;

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
 * seniority ceiling and the location rules apply to every way into a posting, including the
 * `?job=<id>` deep link: a bookmarked drawer must not resurrect a delisted role, a `senior+`
 * one, or a posting the table it came from refuses to list.
 *
 * The location rules are written against `track` rather than against the requested tab, so
 * they hold in `getPostingDetail`, which has no tab. `is not` rather than `<>`: a posting with
 * no track yet is not a Design posting, and `<>` would answer NULL and hide it.
 */
function visible(now: number): SQL[] {
  return [...structural(now), sql`not ${hiddenByLocation}`];
}

/** What the reader asked for, as opposed to what they are allowed to see. */
function userFilters(p: Params, now: number): SQL[] {
  const parts: (SQL | undefined)[] = [];

  if (p.posted) parts.push(gte(postings.postedAt, new Date(now - WINDOW_MS[p.posted])));

  // Every group filter is a SET, so each is an `in`. An empty set is "any" and adds nothing —
  // which is what makes the union semantics right: selecting `entry` and `junior` widens the
  // result, it does not intersect to nothing the way two `eq`s on one column would.
  if (p.type.length > 0) parts.push(inArray(postings.employmentType, p.type as never[]));
  if (p.mode.length > 0) parts.push(inArray(postings.workMode, p.mode as never[]));
  if (p.season.length > 0) parts.push(inArray(postings.internshipSeason, p.season as never[]));
  if (p.level.length > 0) parts.push(inArray(postings.seniority, p.level as never[]));

  // `paid` is the one group that is not a text column, so it cannot use `inArray`.
  //
  // `paid = NULL` is "unknown": it matches neither value, but stays visible while the filter is
  // off (finding G). SQL NULL is not equal to anything, so `eq` already does that — and picking
  // BOTH values is therefore not the same as picking neither. Both means "the posting says
  // something about pay", which excludes the unknowns; neither means "do not ask", which keeps
  // them. That distinction is the reason this filter is worth making multi-select at all.
  if (p.pay.length === 1) parts.push(eq(postings.paid, p.pay[0] === 'paid'));
  else if (p.pay.length > 1) parts.push(isNotNull(postings.paid));

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
/**
 * The most rows a table will render. The Engineering tab had 920 and the cost of a tab switch
 * was linear in every one of them at once: 4,175 bytes of HTML per row, so 3.7 MB of markup
 * (886 KB gzipped), ~14,000 DOM nodes for the browser to build, and 978 KB pulled out of Turso
 * — a 591ms query where the same query capped is 77ms. The table is sorted newest-first and
 * banded at 24 hours, so the rows past this point are the ones nobody scrolls to; the filters,
 * not the scrollbar, are how the rest is reached.
 *
 * `listPostings` asks for one MORE than this, which is how the page knows to say so without
 * paying for a second `count(*)` round trip.
 */
export const ROW_CAP = 200;

export async function listPostings(db: ReadDb, p: Params, now: number = Date.now()) {
  return await driver(db)
    .select(ROW)
    .from(postings)
    .where(where(p, now))
    .orderBy(desc(postings.postedAt), asc(seniorityRank))
    // ROW_CAP + 1: the extra row is not rendered, it is the answer to "is there more?".
    .limit(ROW_CAP + 1)
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
 * How many postings these params would have matched but for the location rules. They are not
 * filters — they are not in `Params`, so `clear` cannot lift them — which means an empty table
 * has to be able to say that geography is why, rather than blaming the ingest. It counts under
 * the same filters it is explaining, so the number is an answer to the question the reader just
 * asked rather than a fact about the whole tab, and it counts exactly what the tab hid: all of
 * `elsewhere` on Design, foreign onsite anywhere else.
 */
export async function outsideTargetLocations(
  db: ReadDb,
  p: Params,
  now: number = Date.now(),
): Promise<number> {
  const row = await driver(db)
    .select({ n: count() })
    .from(postings)
    .where(and(eq(postings.track, p.tab), ...structural(now), ...userFilters(p, now), hiddenByLocation))
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
