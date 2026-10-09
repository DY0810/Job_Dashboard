/**
 * Keyed Tier-2 aggregators (plan Phase 6): Jooble. Adzuna, Careerjet and USAJobs were removed
 * because each API host's robots.txt disallows /.
 *
 * A MISSING KEY IS NOT AN ERROR. Each declares `skip()`, and a skipped connector writes no
 * `connector_runs` row at all — deliberately, not by omission. Ghost detection counts a
 * posting's absence only against an `ok` run (finding C); recording a keyless connector as
 * `ok` with zero postings would make it start delisting other sources' jobs, and recording
 * it as `error` would misreport a healthy run.
 *
 * Jooble carries its credential in the URL path, so its fetch passes an explicit `redactUrl`:
 * a thrown `HttpError` otherwise reprints the URL it failed on.
 *
 * Jooble is metered with a published per-day cap. Six hours (4 calls a day, ~120 a month)
 * keeps it inside its free tier with room to spare. It is also the wrong tier to poll hard
 * — a job that reaches us through it usually reached us through its ATS first.
 */

import { toEpochMs, type Connector } from '../../lib/runtime.ts';
import { aggRow } from './agg.ts';

const SIX_HOURS = 6 * 60 * 60 * 1000;

const missing = (env: Record<string, string | undefined>, ...names: string[]): string | null => {
  const absent = names.filter((name) => !env[name]?.trim());
  return absent.length > 0 ? `${absent.join(', ')} not configured` : null;
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

export const keyedConnectors: Connector[] = [jooble];
