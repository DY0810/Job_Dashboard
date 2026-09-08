/**
 * amazon.jobs — Amazon's own careers search, which publishes JSON.
 *
 * `source_kind = 'ats'` rather than `aggregator`, and that is not a technicality: this is the
 * employer's own board, so its URL is the canonical one and should win `canonical_url` over any
 * aggregator that syndicates the same job. It is not in `ats.ts` only because that file is
 * registry-driven — every connector there fans out over `companies.json` — and this is one
 * company with a bespoke endpoint rather than a tenant of a shared ATS.
 *
 * ROBOTS: `www.amazon.jobs/robots.txt` disallows `/internal` and its localised variants, and
 * nothing else that matters here; the public search path is allowed (checked 2026-08-19). Amazon
 * is also not one of the hard exclusions in `plans/workie.md` — that list is LinkedIn, Indeed,
 * Glassdoor, ZipRecruiter and Handshake, which are aggregators or SSO-walled, not employers
 * publishing their own openings.
 *
 * NO GEOGRAPHY FILTER, deliberately, following the rule the aggregator tier states: every
 * location is stored as reported, and geo is a view concern in `lib/geo.ts` alone. The endpoint
 * does accept `normalized_country_code[]=USA`, and using it would have been the easy way to keep
 * the volume down — but it would push a view filter into ingest, where nothing can lift it again.
 * Volume is bounded by recency instead: `sort=recent`, a fixed page size, and a page cap.
 */

import { parseSections, type EmploymentType } from '../../lib/extract.ts';
import { normalizeDescription } from '../../lib/normalize.ts';
import {
  toEpochMs,
  type Connector,
  type ConnectorPosting,
} from '../../lib/runtime.ts';

interface AmazonJob {
  id_icims?: string;
  title?: string;
  /** "US, CO, Denver" — the display form. */
  location?: string;
  /** "Denver, Colorado, USA" — the one worth normalizing. */
  normalized_location?: string;
  city?: string;
  state?: string;
  country_code?: string;
  /** "August 19, 2026". */
  posted_date?: string;
  /** Relative to the site root: `/en/jobs/10507514/some-title`. */
  job_path?: string;
  job_schedule_type?: string;
  job_category?: string;
  team?: { business_category?: string } | string;
  description?: string;
  basic_qualifications?: string;
  preferred_qualifications?: string;
  is_intern?: unknown;
}

/** 100 is honoured; the endpoint reports `hits: 10000` for an unfiltered query. */
const PAGE = 100;

/** Read the whole accessible search window, not just its first 1,500 jobs. */
const MAX_PAGES = 100;
const AWS_BUSINESS_CATEGORY = 'amazon-web-services';

function searchUrl(offset: number, businessCategory?: string): string {
  const params = new URLSearchParams({
    base_query: '',
    result_limit: String(PAGE),
    offset: String(offset),
    sort: 'recent',
  });
  if (businessCategory) params.append('business_category[]', businessCategory);
  return `https://www.amazon.jobs/en/search.json?${params.toString()}`;
}

/**
 * THE TITLE DECIDES AN INTERNSHIP, NOT THE SCHEDULE FIELD, and that ordering is the fix for a
 * bug this connector shipped with. Amazon sets `job_schedule_type: "full-time"` on its
 * internships — an internship is full-time hours, which is true and useless — and the `is_intern`
 * flag it also returns is `null` on every posting observed, never `true`. Trusting the schedule
 * therefore labelled "Operations Engineer Internship" as `full-time`.
 *
 * That is worse than returning nothing, because `sourceFields` is read BEFORE the prose
 * heuristics in `extract.ts`: a wrong structured value silently outranks the title parse that
 * would have got it right. So the title is checked first, and the schedule only answers when the
 * title is silent.
 */
const INTERN_TITLE = /\b(?:intern|interns|internship|internships|co-?op)\b/i;

function employmentType(job: AmazonJob): EmploymentType | undefined {
  if (job.is_intern === true || INTERN_TITLE.test(job.title ?? '')) return 'internship';
  const raw = (job.job_schedule_type ?? '').toLowerCase().replace(/[\s_-]/g, '');
  if (raw === 'fulltime') return 'full-time';
  if (raw === 'parttime') return 'part-time';
  return undefined;
}

/**
 * The qualifications are the half of an Amazon posting that says who it is for — the seniority
 * and new-grad signals live there far more than in the summary, and the extractor reads the body.
 */
function body(job: AmazonJob): string {
  return [job.description, job.basic_qualifications, job.preferred_qualifications]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

interface AmazonPartition {
  label: string;
  businessCategory?: string;
}

interface AmazonPartitionResult {
  jobs: AmazonJob[];
  pages: number;
  hits: number | null;
  truncated: boolean;
}

async function collectPartition(
  context: Parameters<Connector['fetch']>[0],
  partition: AmazonPartition,
): Promise<AmazonPartitionResult> {
  const jobs: AmazonJob[] = [];
  let pages = 0;
  let hits: number | undefined;

  for (; pages < MAX_PAGES;) {
    let response: { hits?: number; jobs?: AmazonJob[] };
    try {
      response = await context.runtime.fetchJson(searchUrl(pages * PAGE, partition.businessCategory));
      if (!Array.isArray(response.jobs)) throw new Error('Amazon response is missing its jobs array');
    } catch (error) {
      if (pages === 0) throw error;
      context.degraded(`Amazon ${partition.label} page ${pages} failed`);
      break;
    }
    pages += 1;
    hits ??= response.hits;
    jobs.push(...response.jobs);
    if (response.jobs.length < PAGE || (hits !== undefined && jobs.length >= hits)) break;
  }

  const truncated =
    (hits ?? 0) >= MAX_PAGES * PAGE || (pages >= MAX_PAGES && (hits ?? 0) > jobs.length);
  if (truncated) {
    context.degraded(
      `Amazon ${partition.label}: read ${jobs.length} of ${hits} reported hits; search window may be capped`,
    );
  }
  return { jobs, pages, hits: hits ?? null, truncated };
}

function publisherKey(job: AmazonJob): string | null {
  if (typeof job.id_icims === 'string' && job.id_icims) return `id:${job.id_icims}`;
  return typeof job.job_path === 'string' && job.job_path ? `url:${job.job_path}` : null;
}

export const amazon: Connector = {
  name: 'amazon',
  kind: 'ats',
  /** A larger employer search stays on its existing six-hour cadence. */
  minIntervalMs: 6 * 60 * 60 * 1000,
  async fetch(context) {
    const unfiltered = await collectPartition(context, { label: 'unfiltered' });
    let aws: AmazonPartitionResult | null = null;
    try {
      aws = await collectPartition(context, {
        label: AWS_BUSINESS_CATEGORY,
        businessCategory: AWS_BUSINESS_CATEGORY,
      });
    } catch (error) {
      context.degraded(`Amazon ${AWS_BUSINESS_CATEGORY} partition failed`);
      context.log({
        connector: 'amazon',
        partition: AWS_BUSINESS_CATEGORY,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
      });
    }

    const unique = new Map<string, AmazonJob>();
    for (const job of [...unfiltered.jobs, ...(aws?.jobs ?? [])]) {
      const key = publisherKey(job);
      if (key && !unique.has(key)) unique.set(key, job);
    }

    const postings: ConnectorPosting[] = [];
    for (const job of unique.values()) {
      if (!job.job_path || !job.title) continue;
      const text = body(job);
      postings.push({
        source: 'amazon',
        sourceKind: 'ats',
        publisherId: job.id_icims,
        // `new URL(path, base)`, not concatenation: with no terminating slash a `job_path`
        // of `@evil.com/x` makes the ORIGIN evil.com, and this URL is the apply button's
        // href. The sibling Workday builder is safe only because a `/${site}` sits between.
        sourceUrl: new URL(job.job_path, 'https://www.amazon.jobs').toString(),
        postedAt: toEpochMs(job.posted_date),
        company: 'Amazon',
        title: job.title,
        // The normalized form ("Denver, Colorado, USA") parses; the display form leads with a
        // bare country code ("US, CO, Denver") which reads as a city segment.
        location: job.normalized_location ?? job.location ?? null,
        description: normalizeDescription(text),
        sourceFields: {
          employmentType: employmentType(job),
          location: job.normalized_location ?? job.location,
          department: typeof job.team === 'string' ? job.team : job.team?.business_category,
          team: job.job_category,
          sections: parseSections(text),
        },
      });
    }

    context.log({
      connector: 'amazon',
      partitions: [
        {
          label: 'unfiltered',
          pages: unfiltered.pages,
          fetched: unfiltered.jobs.length,
          reportedHits: unfiltered.hits,
          truncated: unfiltered.truncated,
        },
        ...(aws
          ? [
              {
                label: AWS_BUSINESS_CATEGORY,
                pages: aws.pages,
                fetched: aws.jobs.length,
                reportedHits: aws.hits,
                truncated: aws.truncated,
              },
            ]
          : []),
      ],
      fetched: postings.length,
      dedupedWithinSource: unfiltered.jobs.length + (aws?.jobs.length ?? 0) - unique.size,
    });
    return postings;
  },
};
