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
// Freelancer.com — design gigs from its public projects API
// ---------------------------------------------------------------------------------------

interface FreelancerProject {
  id?: number;
  title?: string;
  seo_url?: string;
  type?: string;
  time_submitted?: number;
  preview_description?: string;
  description?: string;
  budget?: { minimum?: number; maximum?: number };
  currency?: { code?: string };
}

/**
 * Freelancer's own job ids: Graphic Design, Logo Design, Web Design, Figma. Unlike the 2026-08
 * free-text `query` this source was rejected for, the `jobs[]` filter bites: an unknown id
 * returns 0 projects, not the whole board (checked 2026-10-13).
 */
const FREELANCER_URL =
  'https://www.freelancer.com/api/projects/0.1/projects/active/?jobs[]=20&jobs[]=32&jobs[]=2701&jobs[]=1936&limit=100&full_description=true';

/**
 * A worldwide gig marketplace, so it is narrowed on our side to USD-priced projects (the API's
 * `currencies[]` filter does not bite). The client is anonymous in the API, hence the fixed
 * company. Every project is remote freelance.
 */
export const freelancer: Connector = {
  name: 'freelancer',
  kind: 'aggregator',
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const body = await context.runtime.fetchJson<{ result?: { projects?: FreelancerProject[] } }>(FREELANCER_URL);
    return (body.result?.projects ?? [])
      .filter((p) => p.seo_url && p.title && p.currency?.code === 'USD')
      .map((p) => {
        const min = p.budget?.minimum ?? 0;
        const max = Math.max(p.budget?.maximum ?? 0, min);
        const rate = min > 0
          ? p.type === 'hourly' ? `Rate: $${min} - $${max} per hour. ` : `Fixed budget: $${min} - $${max}. `
          : '';
        return {
          ...aggRow('freelancer', {
            company: 'Freelancer.com client',
            title: p.title,
            location: 'Remote',
            url: `https://www.freelancer.com/projects/${p.seo_url}`,
            postedAt: toEpochMs(p.time_submitted),
            description: `${rate}${p.description ?? p.preview_description ?? ''}`,
          }),
          sourceFields: { employmentType: 'freelance' as const },
        };
      });
  },
};

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
 * It runs anyway because an API the vendor
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

interface MuseCompany {
  name?: string;
}

/**
 * The provider rejects page 100 even when broad queries report more than 100 pages. Its company
 * filter uses the directory's literal name, not the numeric id. Walk company/category partitions
 * and use only the four verified levels to split a partition that exceeds the page ceiling.
 */
const MUSE_CATEGORIES = [
  'Design and UX',
  'Software Engineering',
  'Data and Analytics',
  'Computer and IT',
  'Science and Engineering',
] as const;
const MUSE_LEVELS = ['Internship', 'Entry Level', 'Mid Level', 'Senior Level'] as const;
const MUSE_PAGE_LIMIT = 100;

interface MuseCheckpoint {
  version: 2;
  directoryPage: number;
  directoryPageCount: number | null;
  companyIndex: number;
  companyName: string | null;
  category: number;
  level: number | null;
  page: number;
  pageCount: number | null;
  providerLimited: number;
  complete: boolean;
}

function emptyMuseCheckpoint(): MuseCheckpoint {
  return {
    version: 2,
    directoryPage: 0,
    directoryPageCount: null,
    companyIndex: 0,
    companyName: null,
    category: 0,
    level: null,
    page: 0,
    pageCount: null,
    providerLimited: 0,
    complete: false,
  };
}

function museCheckpoint(value: unknown): MuseCheckpoint | null {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as Partial<MuseCheckpoint>;
  const directoryPage = candidate.directoryPage;
  const companyIndex = candidate.companyIndex;
  const category = candidate.category;
  const level = candidate.level;
  const page = candidate.page;
  const providerLimited = candidate.providerLimited;
  const complete = candidate.complete;
  if (
    candidate.version !== 2 ||
    typeof directoryPage !== 'number' ||
    !Number.isInteger(directoryPage) ||
    directoryPage < 0 ||
    directoryPage >= MUSE_PAGE_LIMIT ||
    typeof companyIndex !== 'number' ||
    !Number.isInteger(companyIndex) ||
    companyIndex < 0 ||
    (candidate.companyName !== null && typeof candidate.companyName !== 'string') ||
    typeof category !== 'number' ||
    !Number.isInteger(category) ||
    category < 0 ||
    category > MUSE_CATEGORIES.length ||
    (level !== null &&
      (typeof level !== 'number' ||
        !Number.isInteger(level) ||
        level < 0 ||
        level >= MUSE_LEVELS.length)) ||
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 0 ||
    page >= MUSE_PAGE_LIMIT ||
    (candidate.directoryPageCount !== null &&
      candidate.directoryPageCount !== undefined &&
      (!Number.isInteger(candidate.directoryPageCount) || candidate.directoryPageCount < 0)) ||
    (candidate.pageCount !== null &&
      candidate.pageCount !== undefined &&
      (!Number.isInteger(candidate.pageCount) || candidate.pageCount < 0)) ||
    typeof providerLimited !== 'number' ||
    !Number.isInteger(providerLimited) ||
    providerLimited < 0 ||
    typeof complete !== 'boolean'
  ) {
    return null;
  }
  return {
    version: 2,
    directoryPage,
    directoryPageCount: candidate.directoryPageCount ?? null,
    companyIndex,
    companyName: candidate.companyName ?? null,
    category,
    level: level ?? null,
    page,
    pageCount: candidate.pageCount ?? null,
    providerLimited,
    complete,
  };
}

function advanceMusePartition(state: MuseCheckpoint): void {
  state.page = 0;
  state.pageCount = null;
  if (state.level !== null) {
    state.level += 1;
    if (state.level < MUSE_LEVELS.length) return;
    state.level = null;
  }
  state.category += 1;
}

export const muse: Connector = {
  name: 'muse',
  kind: 'aggregator',
  resumable: true,
  skip: (env) => env.MUSE_API_KEY?.trim() ? null : 'MUSE_API_KEY not set; The Muse requires registration for production use',
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const jobs: MuseJob[] = [];
    const request = <T>(path: string, query: URLSearchParams) => {
      const key = context.env.MUSE_API_KEY?.trim();
      if (key) query.set('api_key', key);
      return context.runtime.fetchJson<T>(`https://www.themuse.com/api/public/${path}?${query}`, {
        minGapMs: key ? 1000 : 7200,
      });
    };
    const checkpoint = museCheckpoint(context.checkpoint?.value);
    const checkpointed = context.checkpoint !== undefined;
    const state = checkpoint?.complete ? emptyMuseCheckpoint() : checkpoint ?? emptyMuseCheckpoint();
    const pageBudget = checkpointed ? catchUpPageBudget(context.env) : 2;
    const directories = new Map<number, { results?: MuseCompany[]; page_count?: number }>();
    let requests = 0;

    while (!state.complete && requests < pageBudget) {
      if (state.companyName === null) {
        if (state.directoryPage >= MUSE_PAGE_LIMIT) {
          context.degraded(`Muse: company directory exceeds the ${MUSE_PAGE_LIMIT}-page provider limit`);
          state.providerLimited += 1;
          state.complete = true;
          break;
        }
        let directory = directories.get(state.directoryPage);
        if (!directory) {
          try {
            directory = await request<{ results?: MuseCompany[]; page_count?: number }>(
              'companies', new URLSearchParams({ page: String(state.directoryPage) }));
          } catch (error) {
            context.degraded(`Muse directory page ${state.directoryPage}: ${(error as Error).message}`);
            break;
          }
          requests += 1;
          directories.set(state.directoryPage, directory);
        }
        if (
          typeof directory.page_count !== 'number' ||
          !Number.isInteger(directory.page_count) ||
          directory.page_count < 0
        ) {
          context.degraded(`Muse company directory page ${state.directoryPage}: response omitted page_count`);
          break;
        }
        state.directoryPageCount = directory.page_count;
        const companies = (directory.results ?? [])
          .map((company) => company.name?.trim())
          .filter((name): name is string => Boolean(name));
        if (companies.length === 0 && state.directoryPage + 1 < directory.page_count) {
          context.degraded(`Muse directory page ${state.directoryPage}: empty before advertised end`);
          break;
        }
        if (state.companyIndex >= companies.length) {
          if (companies.length === 0 || state.directoryPage + 1 >= directory.page_count) {
            state.complete = true;
          } else {
            state.directoryPage += 1;
            state.companyIndex = 0;
          }
          continue;
        }
        state.companyName = companies[state.companyIndex];
        state.category = 0;
        state.level = null;
        state.page = 0;
        state.pageCount = null;
        continue;
      }

      if (state.category >= MUSE_CATEGORIES.length) {
        state.companyIndex += 1;
        state.companyName = null;
        state.category = 0;
        state.level = null;
        state.page = 0;
        state.pageCount = null;
        continue;
      }

      const query = new URLSearchParams({
        company: state.companyName,
        category: MUSE_CATEGORIES[state.category],
        page: String(state.page),
        descending: 'true',
      });
      if (state.level !== null) query.set('level', MUSE_LEVELS[state.level]);
      let body: { results?: MuseJob[]; page_count?: number };
      try {
        body = await request('jobs', query);
      } catch (error) {
        context.degraded(
          `Muse ${state.companyName} / ${MUSE_CATEGORIES[state.category]} page ${state.page}: ${(error as Error).message}`,
        );
        break;
      }
      requests += 1;
      const reportedPageCount = body.page_count;
      if (
        typeof reportedPageCount !== 'number' ||
        !Number.isInteger(reportedPageCount) ||
        reportedPageCount < 0
      ) {
        context.degraded(
          `Muse ${state.companyName} / ${MUSE_CATEGORIES[state.category]} page ${state.page}: response omitted page_count`,
        );
        break;
      }

      const rows = body.results ?? [];
      if (state.level === null && reportedPageCount > MUSE_PAGE_LIMIT) {
        // Do not persist an overlapping broad page; the level partitions cover this scope.
        state.level = 0;
        state.page = 0;
        state.pageCount = null;
        continue;
      }

      const providerLimited = state.level !== null && reportedPageCount > MUSE_PAGE_LIMIT;
      if (rows.length === 0 && state.page + 1 < reportedPageCount) {
        context.degraded(
          `Muse ${state.companyName} / ${MUSE_CATEGORIES[state.category]} page ${state.page}: empty before advertised end`,
        );
        break;
      }
      jobs.push(...rows);
      if (state.page + 1 >= Math.min(reportedPageCount, MUSE_PAGE_LIMIT)) {
        if (providerLimited) {
          context.degraded(
            `Muse provider-limited ${state.companyName} / ${MUSE_CATEGORIES[state.category]} / ${MUSE_LEVELS[state.level!]} at ${MUSE_PAGE_LIMIT} pages`,
          );
          state.providerLimited += 1;
        }
        advanceMusePartition(state);
      } else {
        state.page += 1;
        state.pageCount = reportedPageCount;
      }
    }

    if (checkpointed && context.checkpoint) {
      context.checkpoint.save(state satisfies MuseCheckpoint, !state.complete);
    }
    context.log({
      connector: 'muse', fetched: jobs.length, requests,
      directoryPage: state.directoryPage, directoryPages: state.directoryPageCount,
      companyIndex: state.companyIndex, complete: state.complete,
      providerLimited: state.providerLimited,
    });

    // A company/category chunk, including its final page, cannot reconcile other chunks.
    context.degraded(
      `Muse: company-partitioned run read ${jobs.length} rows across ${requests} requests without whole-scan reconciliation`,
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
  workingnomads,
  braintrust,
  freelancer,
  jobicy,
  jobicyEngineering,
  muse,
];
