/**
 * Keyed Tier-2 aggregators (plan Phase 6): Adzuna · Careerjet · Jooble · USAJobs.
 *
 * A MISSING KEY IS NOT AN ERROR. Each declares `skip()`, and a skipped connector writes no
 * `connector_runs` row at all — deliberately, not by omission. Ghost detection counts a
 * posting's absence only against an `ok` run (finding C); recording a keyless connector as
 * `ok` with zero postings would make it start delisting other sources' jobs, and recording
 * it as `error` would misreport a healthy run.
 *
 * Every one of these carries its credential in a URL, so every fetch here passes an explicit
 * `redactUrl`: a thrown `HttpError` otherwise reprints the URL it failed on.
 *
 * All four are metered: Adzuna's free tier is a few hundred calls a MONTH, and Careerjet and
 * Jooble both publish per-day caps. Six hours (4 calls a day, ~120 a month) keeps every one
 * of them inside its free tier with room to spare. They are also the wrong tier to poll hard
 * — a job that reaches us through one of these usually reached us through its ATS first.
 */

import { toEpochMs, type Connector } from '../../lib/runtime.ts';
import { aggRow } from './agg.ts';

const SIX_HOURS = 6 * 60 * 60 * 1000;

const missing = (env: Record<string, string | undefined>, ...names: string[]): string | null => {
  const absent = names.filter((name) => !env[name]?.trim());
  return absent.length > 0 ? `${absent.join(', ')} not configured` : null;
};

interface AdzunaResult {
  title?: string;
  description?: string;
  created?: string;
  redirect_url?: string;
  company?: { display_name?: string };
  location?: { display_name?: string };
}

/**
 * DISABLED BY ROBOTS, not by a missing key, and the distinction matters: a key would not help.
 * `api.adzuna.com/robots.txt` is `User-agent: * / Disallow: /` (checked 2026-08-20) — a blanket
 * refusal on the API host itself, so the runtime's robots check refuses every call this
 * connector makes. Before this skip existed, adding a key turned a working-looking connector
 * into a `RobotsDisallowedError` on every cycle.
 *
 * Note the trap that hid it: `developer.adzuna.com`, where the docs live, IS permissive. Reading
 * robots for the documentation host and assuming the API host agrees is how this got written.
 *
 * Judged differently from SmartRecruiters, whose `Disallow: /` also sits over a documented API:
 * there, the vendor carved out an explicit `Allow:` for another crawler, which is a statement
 * about who may read it. Here there is no carve-out at all. Mapper and shape tests are kept, so
 * re-enabling is deleting this skip.
 */
export const adzuna: Connector = {
  name: 'adzuna',
  kind: 'aggregator',
  skip: () => 'api.adzuna.com/robots.txt disallows / — connector left in place, not run',
  /** Metered free tier — see the file header. */
  minIntervalMs: SIX_HOURS,
  async fetch(context) {
    const url = new URL('https://api.adzuna.com/v1/api/jobs/us/search/1');
    url.searchParams.set('app_id', context.env.ADZUNA_APP_ID!);
    url.searchParams.set('app_key', context.env.ADZUNA_APP_KEY!);
    url.searchParams.set('results_per_page', '50');
    url.searchParams.set('max_days_old', '30');
    url.searchParams.set('content-type', 'application/json');

    const body = await context.runtime.fetchJson<{ results?: AdzunaResult[] }>(url.toString(), {
      redactUrl: 'https://api.adzuna.com/v1/api/jobs/us/search/1',
    });
    return (body.results ?? [])
      .filter((job) => job.redirect_url)
      .map((job) =>
        aggRow('adzuna', {
          company: job.company?.display_name,
          title: job.title,
          location: job.location?.display_name,
          url: job.redirect_url!,
          postedAt: toEpochMs(job.created),
          description: job.description ?? '',
        }),
      );
  },
};

/**
 * The legacy public.api endpoint failed verification. The documented v4 replacement
 * requires a publisher API key and real search-user metadata, and its robots.txt refuses
 * crawling too. Do not revive the old affid request or fabricate a user's IP to enable it.
 */
export const careerjet: Connector = {
  name: 'careerjet',
  kind: 'aggregator',
  skip: () => 'search.api.careerjet.net/robots.txt disallows / — publisher access required',
  /** Metered free tier — see the file header. */
  minIntervalMs: SIX_HOURS,
  async fetch() {
    throw new Error('Careerjet requires a permitted v4 integration before ingestion can be enabled');
  },
};

interface JoobleJob {
  title?: string;
  location?: string;
  snippet?: string;
  link?: string;
  company?: string;
  updated?: string;
}

export const jooble: Connector = {
  name: 'jooble',
  kind: 'aggregator',
  skip: (env) => missing(env, 'JOOBLE_KEY'),
  /** Metered free tier — see the file header. */
  minIntervalMs: SIX_HOURS,
  async fetch(context) {
    // Jooble puts the key in the PATH, so `safeUrl` cannot strip it — this is the case
    // `redactUrl` exists for.
    const body = await context.runtime.fetchJson<{ jobs?: JoobleJob[] }>(
      `https://jooble.org/api/${context.env.JOOBLE_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keywords: 'software engineer, product designer', page: '1' }),
        redactUrl: 'https://jooble.org/api/[key]',
      },
    );
    return (body.jobs ?? [])
      .filter((job) => job.link)
      .map((job) =>
        aggRow('jooble', {
          company: job.company,
          title: job.title,
          location: job.location,
          url: job.link!,
          postedAt: toEpochMs(job.updated),
          description: job.snippet ?? '',
        }),
      );
  },
};

interface UsaJobsItem {
  MatchedObjectDescriptor?: {
    PositionTitle?: string;
    PositionURI?: string;
    OrganizationName?: string;
    PublicationStartDate?: string;
    PositionLocation?: { LocationName?: string }[];
    UserArea?: { Details?: { JobSummary?: string } };
  };
}

/**
 * DISABLED BY ROBOTS, same as `adzuna` above and for the same reason: `data.usajobs.gov/robots.txt`
 * is `User-agent: * / Disallow: /` (checked 2026-08-20). A federal job board refusing all crawlers
 * on its API host is surprising, and it is still what the file says.
 *
 * Worth a human revisit before deletion — USAJobs issues API keys to named callers, and a
 * key-issuing programme is arguably the permission that robots.txt is not granting. That is an
 * argument to make deliberately, in writing, not to assume in code.
 */
export const usajobs: Connector = {
  name: 'usajobs',
  kind: 'aggregator',
  skip: () => 'data.usajobs.gov/robots.txt disallows / — connector left in place, not run',
  /** Metered free tier — see the file header. */
  minIntervalMs: SIX_HOURS,
  async fetch(context) {
    const url = new URL('https://data.usajobs.gov/api/search');
    url.searchParams.set('ResultsPerPage', '50');
    url.searchParams.set('WhoMayApply', 'public');

    const body = await context.runtime.fetchJson<{
      SearchResult?: { SearchResultItems?: UsaJobsItem[] };
    }>(url.toString(), {
      headers: {
        Host: 'data.usajobs.gov',
        // USAJobs requires the registered email as the UA; the key travels in a header, so
        // it never reaches a log line through the URL at all.
        'User-Agent': context.env.USAJOBS_EMAIL!,
        'Authorization-Key': context.env.USAJOBS_KEY!,
      },
    });

    return (body.SearchResult?.SearchResultItems ?? [])
      .map((item) => item.MatchedObjectDescriptor)
      .filter((job): job is NonNullable<typeof job> => Boolean(job?.PositionURI))
      .map((job) =>
        aggRow('usajobs', {
          company: job.OrganizationName,
          title: job.PositionTitle,
          location: job.PositionLocation?.[0]?.LocationName,
          url: job.PositionURI!,
          postedAt: toEpochMs(job.PublicationStartDate),
          description: job.UserArea?.Details?.JobSummary ?? '',
        }),
      );
  },
};

export const keyedConnectors: Connector[] = [adzuna, careerjet, jooble, usajobs];
