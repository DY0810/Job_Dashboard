/**
 * Tier-2 aggregator APIs (plan Phase 6). Real JSON endpoints only — never scraping at this
 * tier. `source_priority = 2`, so when one of these syndicates a job we already have from
 * its ATS, the ATS keeps `canonical_url` and this row survives as an extra `posting_sources`
 * entry.
 *
 * No geography filter anywhere in here: every location is stored as reported. Geo is a view
 * filter on the Design tab only, and only through `lib/geo.ts`.
 */

import type { EmploymentType } from '../../lib/extract.ts';
import { normalizeDescription } from '../../lib/normalize.ts';
import {
  HttpError,
  toEpochMs,
  type Connector,
  type ConnectorContext,
  type ConnectorPosting,
} from '../../lib/runtime.ts';
import { heuristicExtractor, type CompanyExtractor } from './hn-company.ts';

/** Shared with `keyed.ts` — the keyed aggregators map into exactly the same shape. */
export function aggRow(
  source: string,
  fields: {
    company: unknown;
    title: unknown;
    location: unknown;
    url: string;
    postedAt: number;
    description: string;
  },
): ConnectorPosting {
  return {
    source,
    sourceKind: 'aggregator',
    sourceUrl: fields.url,
    postedAt: fields.postedAt,
    company: typeof fields.company === 'string' ? fields.company : '',
    title: typeof fields.title === 'string' ? fields.title : '',
    location: typeof fields.location === 'string' ? fields.location : null,
    description: normalizeDescription(fields.description),
  };
}

// ---------------------------------------------------------------------------------------
// Hacker News "Who is Hiring"
// ---------------------------------------------------------------------------------------

const HN_STORIES =
  'https://hn.algolia.com/api/v1/search_by_date?tags=story,author_whoishiring&hitsPerPage=10';

interface HnComment {
  id?: number;
  text?: string | null;
  created_at_i?: number;
  children?: HnComment[];
}

/**
 * `extractor` is injected so the cached-Haiku version can replace the heuristic without
 * touching this connector. See `hn-company.ts` for why a regex alone is not acceptable here.
 */
export function hnConnector(extractor: CompanyExtractor = heuristicExtractor): Connector {
  return {
    name: 'hn',
    kind: 'aggregator',
    // "Who is Hiring" is ONE THREAD PER MONTH. New comments trickle in through the month,
    // so it is not static — but 48 polls a day against a thread that gains a handful of
    // replies is waste at our end and rudeness at theirs. Four a day sees everything.
    minIntervalMs: 6 * 60 * 60 * 1000,
    async fetch(context: ConnectorContext): Promise<ConnectorPosting[]> {
      const stories = await context.runtime.fetchJson<{
        hits?: { objectID?: string; title?: string; created_at_i?: number }[];
      }>(HN_STORIES);

      // `search_by_date` returns "Who is hiring?" and "Who wants to be hired?" interleaved.
      const story = (stories.hits ?? []).find((hit) => /who is hiring/i.test(hit.title ?? ''));
      if (!story?.objectID) throw new Error('no "Who is hiring" story found');

      const thread = await context.runtime.fetchJson<HnComment>(
        `https://hn.algolia.com/api/v1/items/${story.objectID}`,
      );

      const postings: ConnectorPosting[] = [];
      let skipped = 0;

      for (const comment of thread.children ?? []) {
        if (!comment.text || !comment.id) continue;
        const extracted = await extractor(comment.text);
        if (!extracted) {
          skipped += 1;
          continue;
        }
        postings.push(
          aggRow('hn', {
            company: extracted.company,
            title: extracted.title,
            location: extracted.location,
            url: `https://news.ycombinator.com/item?id=${comment.id}`,
            postedAt: toEpochMs(comment.created_at_i),
            description: comment.text,
          }),
        );
      }

      context.log({
        connector: 'hn',
        story: story.objectID,
        extracted: postings.length,
        // Dropped rather than stored with a guessed company. The cached-Haiku extractor is
        // expected to recover most of these.
        skippedUnextractable: skipped,
      });
      return postings;
    },
  };
}

export const hn = hnConnector();

// ---------------------------------------------------------------------------------------
// RemoteOK · Remotive · Arbeitnow · Working Nomads
// ---------------------------------------------------------------------------------------

interface RemoteOkJob {
  id?: string;
  position?: string;
  company?: string;
  location?: string;
  url?: string;
  apply_url?: string;
  epoch?: number;
  date?: string;
  description?: string;
  legal?: string;
}

export const remoteok: Connector = {
  name: 'remoteok',
  kind: 'aggregator',
  // One endpoint returning the WHOLE board on every call, and RemoteOK asks callers to cache
  // it. Hourly is generous for a feed whose jobs also reach us through their own ATS.
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const jobs = await context.runtime.fetchJson<RemoteOkJob[]>('https://remoteok.com/api');
    return (Array.isArray(jobs) ? jobs : [])
      // Element 0 is RemoteOK's API terms object, not a job.
      .filter((job) => !job.legal && (job.url ?? job.apply_url) && job.position)
      .map((job) =>
        aggRow('remoteok', {
          company: job.company,
          title: job.position,
          // Every RemoteOK listing is remote by definition; `location` is the extra
          // restriction ("Phnom Penh, ") when there is one.
          location: job.location?.trim() ? job.location : 'Remote',
          url: (job.url ?? job.apply_url)!,
          postedAt: toEpochMs(job.epoch ?? job.date),
          description: job.description ?? '',
        }),
      );
  },
};

interface RemotiveJob {
  title?: string;
  company_name?: string;
  url?: string;
  publication_date?: string;
  candidate_required_location?: string;
  description?: string;
}

/**
 * DISABLED, and not by accident: `remotive.com/robots.txt` carries `Disallow: /api/*`.
 *
 * That is not a blanket crawler rule that happens to catch us — it names the exact path this
 * connector would call. SmartRecruiters' `Disallow: /` sits over a documented public API and
 * is arguable; this does not. So Remotive skips the way a keyless connector skips: a logged
 * notice, no `connector_runs` row, no effect on the run's exit code.
 *
 * The mapper below is kept and tested against the documented response shape so that if
 * Remotive changes that line, re-enabling is deleting this `skip`.
 */
export const remotive: Connector = {
  name: 'remotive',
  kind: 'aggregator',
  skip: () => 'remotive.com/robots.txt disallows /api/* — connector left in place, not run',
  async fetch(context) {
    const body = await context.runtime.fetchJson<{ jobs?: RemotiveJob[] }>(
      'https://remotive.com/api/remote-jobs',
    );
    return (body.jobs ?? [])
      .filter((job) => job.url)
      .map((job) =>
        aggRow('remotive', {
          company: job.company_name,
          title: job.title,
          location: job.candidate_required_location ?? 'Remote',
          url: job.url!,
          postedAt: toEpochMs(job.publication_date),
          description: job.description ?? '',
        }),
      );
  },
};

/**
 * REMOVED: arbeitnow. A German board — 234 of the 235 rows it had contributed were outside the
 * US, and the one that was not was an accident. Worse, it reported `remote ? 'Remote' : location`,
 * which threw the country away on exactly the rows the location rules would otherwise have
 * caught, so a Berlin-onsite job arrived indistinguishable from a work-from-anywhere one.
 *
 * Kept as a note rather than deleted silently because "a broad board costs nothing" is written
 * two connectors down, and it is wrong when the board is national: the cost is a filter that
 * cannot tell where the job is.
 */

interface WorkingNomadsJob {
  title?: string;
  company_name?: string;
  url?: string;
  location?: string;
  pub_date?: string;
  description?: string;
}

/**
 * Working Nomads is listed as an RSS source in the plan, but its feed endpoints all 404 now
 * (`/jobsrss`, `/rss`, `?rss=1` — checked against the live site). It publishes the same jobs
 * as JSON at `/api/exposed_jobs/`, so this is an aggregator-tier connector rather than an
 * RSS one, and its `source_priority` is 2 rather than 3.
 */
export const workingnomads: Connector = {
  name: 'workingnomads',
  kind: 'aggregator',
  /** A feed in all but name (see above) and feeds publish hourly at best. Hourly. */
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const jobs = await context.runtime.fetchJson<WorkingNomadsJob[]>(
      'https://www.workingnomads.com/api/exposed_jobs/',
    );
    return (Array.isArray(jobs) ? jobs : [])
      .filter((job) => job.url)
      .map((job) =>
        aggRow('workingnomads', {
          company: job.company_name,
          title: job.title,
          location: job.location ?? 'Remote',
          url: job.url!,
          postedAt: toEpochMs(job.pub_date),
          description: job.description ?? '',
        }),
      );
  },
};

// ---------------------------------------------------------------------------------------
// Braintrust — freelance design, which the ATS boards structurally cannot supply
// ---------------------------------------------------------------------------------------

interface BraintrustJob {
  id?: number;
  title?: string;
  employer?: { name?: string };
  job_type?: string;
  payment_type?: string;
  budget_minimum_usd?: string;
  budget_maximum_usd?: string;
  expected_hours_per_week?: number;
  created?: string;
  main_skills?: { name?: string }[];
  locations?: { location?: string; country?: string }[];
}

/** `?role=3` is Braintrust's own Design filter — the whole board narrowed at the source. */
const BRAINTRUST_URL = 'https://app.usebraintrust.com/api/jobs/?role=3&page_size=100';

/** `payment_type` to the phrasing `extract.ts` already parses out of prose. */
const BRAINTRUST_PERIOD: Record<string, string> = { hourly: 'per hour', annual: 'per year' };

/**
 * Every posting here is freelance, which is the point: the ATS connectors poll employers'
 * own boards, and an employer's own board does not carry the contract work it hands to
 * agencies and marketplaces. This is the one source verified to supply US freelance design
 * with structured locations — small (4 open design roles at the time of writing) but exactly
 * on target, where a general gig marketplace would be large and mostly irrelevant.
 *
 * The API publishes no description at all, so one is assembled from the structured fields.
 * That is not decoration: `extract.ts` reads pay out of prose, so the rate has to be written
 * in a form it parses or a $130/hour engagement lands with no pay rate at all. `paid` follows
 * from the same sentence.
 */
export const braintrust: Connector = {
  name: 'braintrust',
  kind: 'aggregator',
  /** One request covers the whole design board. Hourly, like the other whole-board sources. */
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const body = await context.runtime.fetchJson<{ results?: BraintrustJob[] }>(BRAINTRUST_URL);
    return (body.results ?? [])
      .filter((job) => job.id && job.title)
      .map((job) => {
        const period = BRAINTRUST_PERIOD[job.payment_type ?? ''];
        const min = Number(job.budget_minimum_usd);
        const max = Number(job.budget_maximum_usd);
        const rate =
          period && Number.isFinite(min) && min > 0
            ? `Rate: $${min} - $${Number.isFinite(max) && max > min ? max : min} ${period}. `
            : '';
        const hours = job.expected_hours_per_week ? `Expected ${job.expected_hours_per_week} hours per week. ` : '';
        const skills = (job.main_skills ?? []).map((skill) => skill.name).filter(Boolean);

        // A role is often open in several places at once. Prefer a US one: the Design tab
        // hides everything outside the target locations, so picking a non-US location off a
        // role that is also open in New York would hide a posting that qualifies.
        const locations = job.locations ?? [];
        const location = (locations.find((l) => l.country === 'US') ?? locations[0])?.location ?? null;

        return {
          ...aggRow('braintrust', {
            company: job.employer?.name,
            title: job.title,
            location,
            url: `https://app.usebraintrust.com/jobs/${job.id}/`,
            postedAt: toEpochMs(job.created),
            description: `${rate}${hours}Freelance engagement via Braintrust.${skills.length ? ` Skills: ${skills.join(', ')}.` : ''}`,
          }),
          // Braintrust is a freelance marketplace end to end; `job_type` has read `freelance`
          // on every row observed. Trusted only when it says so, never assumed.
          ...(job.job_type === 'freelance' ? { sourceFields: { employmentType: 'freelance' as const } } : {}),
        };
      });
  },
};

// ---------------------------------------------------------------------------------------
// Himalayas
// ---------------------------------------------------------------------------------------

interface HimalayasJob {
  title?: string;
  companyName?: string;
  employmentType?: string;
  locationRestrictions?: string[];
  pubDate?: number;
  applicationLink?: string;
  guid?: string;
  description?: string;
  excerpt?: string;
}

/** Himalayas spells the type with a space and title case; the schema uses hyphenated lower. */
const HIMALAYAS_TYPE: Record<string, EmploymentType> = {
  'full time': 'full-time',
  'part time': 'part-time',
  contract: 'contract',
  freelance: 'freelance',
  internship: 'internship',
  temporary: 'contract',
};

/**
 * A general remote board rather than a design one, so it feeds both tracks. Worth having for
 * the same reason workingnomads is: `track` is decided from the title, so a
 * broad board costs nothing but a classification pass and widens both tabs.
 *
 * `locationRestrictions` is where the US filter is actually won — a row restricted to
 * "United States" normalizes to a US location instead of the bare "Remote" that most remote
 * boards report, which is the difference between landing in a target tier and landing nowhere.
 *
 * The current provider contract caps a page at 20 and returns an opaque `nextCursor`. Cursor
 * traversal avoids the duplicates and skips that changing offset pagination can produce. Five
 * pages per run keep each catch-up chunk bounded; a persisted cursor resumes the full active
 * catalogue on the next cloud cycle.
 */
const HIMALAYAS_PAGES = 5;
const HIMALAYAS_PAGE = 20;
const ONE_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_CATCH_UP_PAGES = 100;
const MAX_CATCH_UP_PAGES = 1000;

function catchUpPageBudget(env: Record<string, string | undefined>): number {
  const raw = env.WORKIE_CATCH_UP_PAGES?.trim();
  if (!raw) return DEFAULT_CATCH_UP_PAGES;
  if (!/^\d+$/.test(raw)) {
    throw new Error('WORKIE_CATCH_UP_PAGES must be an integer between 1 and 1000');
  }
  const pages = Number(raw);
  if (pages < 1 || pages > MAX_CATCH_UP_PAGES) {
    throw new Error('WORKIE_CATCH_UP_PAGES must be an integer between 1 and 1000');
  }
  return pages;
}

interface HimalayasCheckpoint {
  version: 1;
  cursor: string | null;
  providerUpdatedAt: number | null;
  providerTotal: number | null;
  scanned: number;
  complete: boolean;
}

function himalayasCheckpoint(value: unknown): HimalayasCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<HimalayasCheckpoint>;
  const scanned = candidate.scanned;
  const complete = candidate.complete;
  if (
    candidate.version !== 1 ||
    typeof complete !== 'boolean' ||
    typeof scanned !== 'number' ||
    !Number.isInteger(scanned) ||
    scanned < 0 ||
    (candidate.cursor !== null && typeof candidate.cursor !== 'string') ||
    (candidate.providerUpdatedAt !== null &&
      candidate.providerUpdatedAt !== undefined &&
      typeof candidate.providerUpdatedAt !== 'number') ||
    (candidate.providerTotal !== null &&
      candidate.providerTotal !== undefined &&
      typeof candidate.providerTotal !== 'number')
  ) {
    return null;
  }
  return {
    version: 1,
    cursor: candidate.cursor ?? null,
    providerUpdatedAt: candidate.providerUpdatedAt ?? null,
    providerTotal: candidate.providerTotal ?? null,
    scanned,
    complete,
  };
}

export const himalayas: Connector = {
  name: 'himalayas',
  kind: 'aggregator',
  // The provider documents a daily data refresh. More frequent polls only re-read its cache.
  minIntervalMs: ONE_DAY,
  async fetch(context) {
    const jobs: HimalayasJob[] = [];
    const checkpoint = himalayasCheckpoint(context.checkpoint?.value);
    const restartingSweep = context.checkpoint !== undefined && checkpoint?.complete === true;
    const catchingUp = context.checkpoint !== undefined;
    const pageBudget = catchingUp ? catchUpPageBudget(context.env) : HIMALAYAS_PAGES;
    let pages = 0;
    let totalCount: number | undefined;
    let updatedAt: number | undefined;
    let cursor: string | undefined = restartingSweep ? undefined : checkpoint?.cursor ?? undefined;
    let resetCursor = false;
    const seenCursors = new Set(cursor ? [cursor] : []);
    for (let page = 0; page < pageBudget; page += 1) {
      const query = new URLSearchParams({ limit: String(HIMALAYAS_PAGE) });
      if (cursor) query.set('cursor', cursor);
      let body: {
        totalCount?: number;
        nextCursor?: string;
        updatedAt?: number;
        jobs?: HimalayasJob[];
      };
      try {
        body = await context.runtime.fetchJson(`https://himalayas.app/jobs/api?${query}`);
      } catch (error) {
        if (cursor && error instanceof HttpError && error.status === 400) {
          resetCursor = true;
          cursor = undefined;
          context.degraded('Himalayas: provider rejected checkpoint cursor; resetting to the head');
          break;
        }
        throw error;
      }
      totalCount ??= body.totalCount;
      updatedAt ??= body.updatedAt;
      const nextCursor = typeof body.nextCursor === 'string' && body.nextCursor ? body.nextCursor : undefined;
      if (!body.jobs?.length) {
        if (nextCursor && !seenCursors.has(nextCursor)) {
          cursor = nextCursor;
          seenCursors.add(nextCursor);
          pages += 1;
          continue;
        }
        if (nextCursor) {
          resetCursor = true;
          context.degraded('Himalayas: provider repeated a cursor after an empty page; resetting to the head');
        }
        cursor = undefined;
        break;
      }
      jobs.push(...body.jobs);
      pages += 1;
      if (nextCursor && seenCursors.has(nextCursor)) {
        resetCursor = true;
        cursor = undefined;
        context.degraded('Himalayas: provider repeated a cursor; resetting to the head');
        break;
      }
      cursor = nextCursor;
      if (cursor) seenCursors.add(cursor);
      // The absence of a next cursor is the provider's completion signal.
      if (body.jobs.length < HIMALAYAS_PAGE || !cursor) break;
    }

    if (catchingUp && context.checkpoint) {
      const complete = !resetCursor && cursor === undefined;
      context.checkpoint.save(
        {
          version: 1,
          cursor: cursor ?? null,
          providerUpdatedAt: updatedAt ?? checkpoint?.providerUpdatedAt ?? null,
          providerTotal: totalCount ?? checkpoint?.providerTotal ?? null,
          scanned: restartingSweep || resetCursor ? jobs.length : (checkpoint?.scanned ?? 0) + jobs.length,
          complete,
        } satisfies HimalayasCheckpoint,
        !complete,
      );
    }

    // A chunk never reconciles the whole source. Even its final chunk must not age the
    // postings seen in earlier chunks toward deletion.
    context.degraded(
      catchingUp
        ? `Himalayas: checkpoint catch-up read ${jobs.length} rows across ${pages} cursor pages`
        : `Himalayas: normal head refresh read ${jobs.length} rows without whole-scan reconciliation`,
    );
    context.log({
      connector: 'himalayas',
      pages,
      fetched: jobs.length,
      reportedTotal: totalCount ?? null,
      checkpointCatchup: catchingUp,
      checkpointPending: catchingUp ? cursor !== undefined : null,
    });
    return jobs
      .filter((job) => job.applicationLink ?? job.guid)
      .map((job) => {
        const type = HIMALAYAS_TYPE[(job.employmentType ?? '').trim().toLowerCase()];
        return {
          ...aggRow('himalayas', {
            company: job.companyName,
            title: job.title,
            // Several restrictions means several eligible countries; the first is enough for
            // the normalizer, and "Remote" is the honest fallback when there are none.
            location: job.locationRestrictions?.[0] ?? 'Remote',
            url: (job.applicationLink ?? job.guid)!,
            postedAt: toEpochMs(job.pubDate),
            description: job.description ?? job.excerpt ?? '',
          }),
          ...(type ? { sourceFields: { employmentType: type } } : {}),
        };
      });
  },
};


// ---------------------------------------------------------------------------------------
// Jobicy — the one design-filtered board found by the source survey that was still alive
// ---------------------------------------------------------------------------------------

interface JobicyJob {
  id?: number;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  /** "USA" · "Anywhere" · "Europe,  USA" — comma-separated, with doubled spaces. */
  jobGeo?: string;
  pubDate?: string;
  jobDescription?: string;
  jobExcerpt?: string;
  /** Array: ["Full-Time"] | ["Part-Time"] | ["Contract"]. */
  jobType?: string[];
  jobLevel?: string | string[];
  salaryMin?: number;
  salaryMax?: number;
  salaryPeriod?: string;
}

/**
 * Jobicy's live taxonomy has separate `design-multimedia` and `engineering` slugs. They are
 * separate connectors because the API returns one industry's newest window per request and the
 * two windows have different completeness states.
 *
 * The filter genuinely bites, which is why this source is worth having where Freelancer.com was
 * not: a slug the board does not know returns HTTP 400 with `Invalid 'industry' value`, rather
 * than silently serving the unfiltered board.
 */
const JOBICY_PAGE_SIZE = 200;

/** Their spelling, hyphenated and title-cased, to the schema's. */
const JOBICY_TYPE: Record<string, EmploymentType> = {
  'full-time': 'full-time',
  'part-time': 'part-time',
  contract: 'contract',
  freelance: 'freelance',
  internship: 'internship',
};

/**
 * ROBOTS.TXT COULD NOT BE READ, and that is a deliberate exception rather than an oversight.
 * `jobicy.com/robots.txt` answers a Cloudflare interactive challenge — HTTP 403, "Just a
 * moment...", a JS challenge page — so there is no allowance to record and no disallowance
 * either (checked 2026-08-20). The API path itself answers 200 to this User-Agent, so whatever
 * their edge is protecting, it is not this endpoint.
 *
 * Running it anyway follows the precedent this project already set for SmartRecruiters, whose
 * robots.txt taken literally refuses us over a documented public API: an API the vendor
 * publishes and documents for programmatic use — Jobicy's is documented at
 * github.com/Jobicy/remote-jobs-api — is the stronger statement of intent. That is a judgement,
 * not a rule, and it is the one thing here worth reversing first if the maintainer disagrees:
 * delete this connector from `aggConnectors`, or give it a `skip` the way `remotive` has.
 *
 * Jobicy publishes no page or cursor contract. `jobCount < count` is therefore the only proof
 * that an industry's returned window is complete; an equal count stays partial rather than
 * silently claiming the capped window is the whole catalogue.
 */
function jobicyConnector(name: string, industry: string): Connector {
  return {
    name,
    kind: 'aggregator',
    minIntervalMs: 60 * 60 * 1000,
    async fetch(context) {
      const url = new URL('https://jobicy.com/api/v2/remote-jobs');
      url.searchParams.set('count', String(JOBICY_PAGE_SIZE));
      url.searchParams.set('industry', industry);
      const body = await context.runtime.fetchJson<{ jobCount?: number; jobs?: JobicyJob[] }>(
        url.toString(),
      );
      const jobs = body.jobs ?? [];
      const reportedCount = body.jobCount ?? null;
      if (reportedCount !== null && reportedCount >= JOBICY_PAGE_SIZE) {
        context.degraded(`${name}: received ${reportedCount} jobs at the ${JOBICY_PAGE_SIZE}-row API cap`);
      }
      context.log({ connector: name, industry, fetched: jobs.length, reportedCount });

      return jobs
        .filter((job) => job.url && job.jobTitle)
        .map((job) => {
          const type = JOBICY_TYPE[(job.jobType?.[0] ?? '').trim().toLowerCase()];
          return {
            ...aggRow(name, {
            company: job.companyName,
            title: job.jobTitle,
            // "Europe,  USA" is a list of eligible regions, not one place, and the doubled
            // spaces are theirs. The first entry is enough for `normalizeLocation`; "Anywhere"
            // is already one of its remote markers.
            location: (job.jobGeo ?? '').split(',')[0]?.trim() || 'Anywhere',
            url: job.url!,
            postedAt: toEpochMs(job.pubDate),
            description: job.jobDescription ?? job.jobExcerpt ?? '',
          }),
            ...(type ? { sourceFields: { employmentType: type } } : {}),
          };
        });
    },
  };
}

/** Complete as of the 2026-09-08 live check: 60 rows below the 200-row provider cap. */
export const jobicy = jobicyConnector('jobicy', 'design-multimedia');

/** The current engineering response reaches the provider cap and is intentionally partial. */
export const jobicyEngineering = jobicyConnector('jobicy-engineering', 'engineering');

// ---------------------------------------------------------------------------------------
// The Muse
// ---------------------------------------------------------------------------------------

interface MuseJob {
  name?: string;
  contents?: string;
  publication_date?: string;
  company?: { name?: string };
  locations?: { name?: string }[];
  levels?: { name?: string }[];
  refs?: { landing_page?: string };
}

/**
 * Level filtering was not reliable in a live check: a Management request returned a Mid Level
 * row. Checkpointed category walks leave eligibility to the existing deterministic extractor,
 * which is the shared authority on tracks and seniority.
 */
const MUSE_SCOPES = ['Design and UX', 'Science and Engineering'] as const;

interface MuseCheckpoint {
  version: 1;
  scope: number;
  page: number;
  pageCount: number | null;
  complete: boolean;
}

function museCheckpoint(value: unknown): MuseCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MuseCheckpoint>;
  const scope = candidate.scope;
  const page = candidate.page;
  const complete = candidate.complete;
  if (
    candidate.version !== 1 ||
    typeof scope !== 'number' ||
    !Number.isInteger(scope) ||
    scope < 0 ||
    scope > MUSE_SCOPES.length ||
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 0 ||
    (candidate.pageCount !== null &&
      candidate.pageCount !== undefined &&
      (!Number.isInteger(candidate.pageCount) || candidate.pageCount < 0)) ||
    typeof complete !== 'boolean'
  ) {
    return null;
  }
  return {
    version: 1,
    scope,
    page,
    pageCount: candidate.pageCount ?? null,
    complete,
  };
}

export const muse: Connector = {
  name: 'muse',
  kind: 'aggregator',
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const jobs: MuseJob[] = [];
    const checkpoint = museCheckpoint(context.checkpoint?.value);
    const restartingSweep = context.checkpoint !== undefined && checkpoint?.complete === true;
    const catchingUp = context.checkpoint !== undefined && !restartingSweep;
    const pageBudget = catchingUp ? catchUpPageBudget(context.env) : MUSE_SCOPES.length;
    let scope = catchingUp ? checkpoint?.scope ?? 0 : 0;
    let page = catchingUp ? checkpoint?.page ?? 0 : 0;
    let pageCount = catchingUp ? checkpoint?.pageCount ?? null : null;
    let requests = 0;
    const headPageCounts: Array<number | null> = [];
    let headFailed = false;

    while (scope < MUSE_SCOPES.length && requests < pageBudget) {
      const query = new URLSearchParams({
        category: MUSE_SCOPES[scope],
        page: String(page),
        descending: 'true',
      });
      let body: { results?: MuseJob[]; page_count?: number };
      try {
        body = await context.runtime.fetchJson(`https://www.themuse.com/api/public/jobs?${query}`);
      } catch (error) {
        context.degraded(`${MUSE_SCOPES[scope]} page ${page}: ${(error as Error).message}`);
        headFailed = true;
        break;
      }
      requests += 1;
      const reportedPageCount = body.page_count;
      if (
        typeof reportedPageCount !== 'number' ||
        !Number.isInteger(reportedPageCount) ||
        reportedPageCount < 0
      ) {
        context.degraded(`${MUSE_SCOPES[scope]} page ${page}: response omitted page_count`);
        headFailed = true;
        break;
      }

      pageCount = reportedPageCount;
      if (!catchingUp && page === 0) headPageCounts[scope] = reportedPageCount;
      const rows = body.results ?? [];
      if (rows.length === 0 && page + 1 < reportedPageCount) {
        context.degraded(`${MUSE_SCOPES[scope]} page ${page}: empty before advertised end`);
        headFailed = true;
        break;
      }
      jobs.push(...rows);
      if (!catchingUp || rows.length === 0 || page + 1 >= reportedPageCount) {
        scope += 1;
        page = 0;
        pageCount = null;
      } else {
        page += 1;
      }
    }

    if (catchingUp && context.checkpoint) {
      const complete = scope >= MUSE_SCOPES.length;
      context.checkpoint.save(
        {
          version: 1,
          scope,
          page,
          pageCount,
          complete,
        } satisfies MuseCheckpoint,
        !complete,
      );
    } else if (restartingSweep && context.checkpoint && !headFailed) {
      const designHasMore = (headPageCounts[0] ?? 0) > 1;
      const scienceHasRows = (headPageCounts[1] ?? 0) > 0;
      const complete = !designHasMore && !scienceHasRows;
      context.checkpoint.save(
        {
          version: 1,
          scope: designHasMore ? 0 : scienceHasRows ? 1 : MUSE_SCOPES.length,
          page: designHasMore ? 1 : 0,
          pageCount: designHasMore ? headPageCounts[0] ?? null : null,
          complete,
        } satisfies MuseCheckpoint,
        !complete,
      );
    }

    // A category chunk, including its final page, cannot reconcile postings seen by other
    // chunks and must never age them toward deletion.
    context.degraded(
      catchingUp
        ? `Muse: checkpoint catch-up read ${jobs.length} rows across ${requests} category pages`
        : `Muse: normal category-head refresh read ${jobs.length} rows without whole-scan reconciliation`,
    );
    return jobs
      .filter((job) => job.refs?.landing_page)
      .map((job) =>
        aggRow('muse', {
          company: job.company?.name,
          title: job.name,
          // The Muse is not remote-only. A missing location is unknown, not a claim that the
          // role is remote; only sources that define every listing as remote may use that
          // fallback.
          location: job.locations?.[0]?.name ?? null,
          url: job.refs!.landing_page!,
          postedAt: toEpochMs(job.publication_date),
          description: job.contents ?? '',
        }),
      );
  },
};

export const aggConnectors: Connector[] = [
  hn,
  remoteok,
  remotive,
  workingnomads,
  braintrust,
  himalayas,
  jobicy,
  jobicyEngineering,
  muse,
];
