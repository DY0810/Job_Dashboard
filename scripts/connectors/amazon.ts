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

/**
 * Fifteen pages, so 1,500 of the newest per run. The cut is defensible because this endpoint
 * sorts by recency, so it falls at "older than the newest 1,500" rather than on an arbitrary
 * slice — but the number had to be measured, because Amazon's volume is the whole problem:
 *
 *   offset    0 → August 20-19        offset  900 → August 14-13
 *   offset  400 → August 19-18        offset 1900 → August 10
 *
 * 500 covered barely a day and a half. 1,500 reaches roughly a week, which matters because
 * postings arrive here in bursts and a run that lands after a busy afternoon would otherwise
 * miss everything published before it. Amazon does not throttle this endpoint — 500 postings
 * came back in 4.7s — so the cost is 15 cheap requests every six hours.
 *
 * Deeper is not better: past ~2,000 the ordering stops agreeing with `posted_date` (offset 3900
 * returned August 14 alongside August 3), so the endpoint is evidently sorting on something
 * adjacent to it. Paging further buys jumble, not history.
 */
const MAX_PAGES = 15;

function searchUrl(offset: number): string {
  const params = new URLSearchParams({
    base_query: '',
    result_limit: String(PAGE),
    offset: String(offset),
    sort: 'recent',
  });
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

export const amazon: Connector = {
  name: 'amazon',
  kind: 'ats',
  /** One employer, 1,500 postings a run, and its board does not turn over in half an hour. */
  minIntervalMs: 6 * 60 * 60 * 1000,
  async fetch(context) {
    const postings: ConnectorPosting[] = [];
    let pages = 0;
    let hits: number | undefined;

    for (; pages < MAX_PAGES; pages += 1) {
      const page = await context.runtime.fetchJson<{ hits?: number; jobs?: AmazonJob[] }>(
        searchUrl(pages * PAGE),
      );
      hits ??= page.hits;
      const jobs = page.jobs ?? [];

      for (const job of jobs) {
        if (!job.job_path || !job.title) continue;
        const text = body(job);
        postings.push({
          source: 'amazon',
          sourceKind: 'ats',
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
      if (jobs.length < PAGE) break;
    }

    context.log({
      connector: 'amazon',
      pages,
      fetched: postings.length,
      reportedHits: hits ?? null,
      // Said out loud rather than left implicit: this is the newest slice, not the board.
      truncated: pages >= MAX_PAGES && (hits ?? 0) > postings.length,
    });
    return postings;
  },
};
