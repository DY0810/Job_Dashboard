/**
 * Tier-2 aggregator APIs (plan Phase 6). Real JSON endpoints only — never scraping at this
 * tier. `source_priority = 2`, so when one of these syndicates a job we already have from
 * its ATS, the ATS keeps `canonical_url` and this row survives as an extra `posting_sources`
 * entry.
 *
 * No geography filter anywhere in here: every location is stored as reported. Geo affects
 * ranking on the Design tab only, and only through `lib/geo.ts`.
 */

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

interface ArbeitnowJob {
  title?: string;
  company_name?: string;
  url?: string;
  location?: string;
  remote?: boolean;
  created_at?: number;
  description?: string;
}

export const arbeitnow: Connector = {
  name: 'arbeitnow',
  kind: 'aggregator',
  /** Whole board in one response, same as RemoteOK. Hourly. */
  minIntervalMs: 60 * 60 * 1000,
  async fetch(context) {
    const body = await context.runtime.fetchJson<{ data?: ArbeitnowJob[] }>(
      'https://www.arbeitnow.com/api/job-board-api',
    );
    return (body.data ?? [])
      .filter((job) => job.url)
      .map((job) =>
        aggRow('arbeitnow', {
          company: job.company_name,
          title: job.title,
          location: job.remote ? 'Remote' : job.location,
          url: job.url!,
          postedAt: toEpochMs(job.created_at),
          description: job.description ?? '',
        }),
      );
  },
};

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

export const aggConnectors: Connector[] = [hn, remoteok, remotive, arbeitnow, workingnomads];
