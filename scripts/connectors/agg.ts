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
 * PAGED, because the endpoint caps a page at 20 however large a `limit` you send — it echoes
 * `"limit": 20` back at you — and one page an hour off a board of 100k postings is a trickle
 * that would mostly re-fetch what it already had. Five pages is 100 newest per run, bounded so
 * a board that keeps answering cannot turn one cycle into an unbounded crawl.
 */
const HIMALAYAS_PAGES = 5;
const HIMALAYAS_PAGE = 20;

export const himalayas: Connector = {
  name: 'himalayas',
  kind: 'aggregator',
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const jobs: HimalayasJob[] = [];
    for (let page = 0; page < HIMALAYAS_PAGES; page += 1) {
      const body = await context.runtime.fetchJson<{ jobs?: HimalayasJob[] }>(
        `https://himalayas.app/jobs/api?limit=${HIMALAYAS_PAGE}&offset=${page * HIMALAYAS_PAGE}`,
      );
      // A short page means the board ran out; asking for the next one would return nothing.
      if (!body.jobs?.length) break;
      jobs.push(...body.jobs);
      if (body.jobs.length < HIMALAYAS_PAGE) break;
    }
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
 * ONE REQUEST IS THE WHOLE DESIGN CORPUS, verified rather than assumed: the board publishes two
 * design industry slugs, and `web-app-design` (15 rows) is entirely contained in
 * `design-multimedia` (39) — every id in the smaller set appears in the larger. Polling both
 * would double the requests for nothing.
 *
 * The filter genuinely bites, which is why this source is worth having where Freelancer.com was
 * not: a slug the board does not know returns HTTP 400 with `Invalid 'industry' value`, rather
 * than silently serving the unfiltered board.
 */
const JOBICY_URL = 'https://jobicy.com/api/v2/remote-jobs?count=100&industry=design-multimedia';

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
 * ponytail: no paging. The design slug returns 39 of a 100-row cap in one call, so there is
 * nothing to page through. Add an `offset` loop if the design corpus ever approaches 100.
 */
export const jobicy: Connector = {
  name: 'jobicy',
  kind: 'aggregator',
  /** Whole design board in one response; it stamped `lastUpdate` once in the hour observed. */
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const body = await context.runtime.fetchJson<{ jobCount?: number; jobs?: JobicyJob[] }>(
      JOBICY_URL,
    );
    const jobs = body.jobs ?? [];
    context.log({ connector: 'jobicy', fetched: jobs.length, reportedCount: body.jobCount ?? null });

    return jobs
      .filter((job) => job.url && job.jobTitle)
      .map((job) => {
        const type = JOBICY_TYPE[(job.jobType?.[0] ?? '').trim().toLowerCase()];
        return {
          ...aggRow('jobicy', {
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

// ---------------------------------------------------------------------------------------
// The Muse — the only board found where BOTH location and level are structured and filterable
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
 * Asked per LEVEL, not once for the category, and that is the whole point of this source.
 *
 * `category=Design and UX` alone is 2,256 rows, ~1,800 of them senior — rows `enrich` would
 * fetch, classify and then throw away. The API filters server-side on a real enumerated field,
 * so asking only for the three levels this dashboard keeps turns a 113-page download into ~8
 * pages. Measured 2026-08-24: Internship 35, Entry Level 2, Mid Level 410.
 *
 * `descending=true` matters as much. Unsorted, the first page is a mix reaching back over a
 * year — The Muse leaves stale rows published; sorted, page 0 runs 13-14 of 20 inside the
 * 60-day window with a median age under a month.
 */
const MUSE_LEVELS = ['Internship', 'Entry Level', 'Mid Level'] as const;
/** Mid Level is 21 pages; the tail is progressively staler, so the newest few are the value. */
const MUSE_PAGES = 3;

export const muse: Connector = {
  name: 'muse',
  kind: 'aggregator',
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const jobs: MuseJob[] = [];
    for (const level of MUSE_LEVELS) {
      for (let page = 0; page < MUSE_PAGES; page += 1) {
        const query = new URLSearchParams({
          category: 'Design and UX',
          level,
          page: String(page),
          descending: 'true',
        });
        // A page that fails ends THIS level and keeps everything already collected, the way
        // the ATS connectors isolate one dead board token from the rest of the registry.
        // Nine requests per cycle is nine chances to throw away eight good pages otherwise.
        let body: { results?: MuseJob[]; page_count?: number };
        try {
          body = await context.runtime.fetchJson(`https://www.themuse.com/api/public/jobs?${query}`);
        } catch (error) {
          context.degraded(`${level} page ${page}: ${(error as Error).message}`);
          break;
        }
        if (!body.results?.length) break;
        jobs.push(...body.results);
        // `page` is zero-based and `page_count` is a count, so this is the last page.
        if (page + 1 >= (body.page_count ?? 0)) break;
      }
    }
    return jobs
      .filter((job) => job.refs?.landing_page)
      .map((job) =>
        aggRow('muse', {
          company: job.company?.name,
          title: job.name,
          // Several offices means several rows on one posting; the first is enough for the
          // normalizer, and these are already "City, ST" rather than free text.
          location: job.locations?.[0]?.name ?? 'Remote',
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
  muse,
];
