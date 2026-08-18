/**
 * `npm run linkcheck` — does every stored apply link still lead to a live posting?
 *
 * The acceptance criterion is "every apply link resolves to a LIVE posting", and finding H
 * in plans/worky.md is the reason this is not a status-code script: several ATS platforms
 * answer 200 for a job that is gone. Verified against the live platforms on 2026-08-18:
 *
 *   greenhouse  a withdrawn job 302s to the board index and answers **200**
 *               (`/twilio/jobs/1` -> `/twilio?error=true`, `<title>Jobs at Twilio</title>`)
 *   ashby       an unknown job id answers **200** with the bare SPA shell, `<title>Jobs</title>`
 *   workable    an unknown job answers **200** with `og:title` = "Current Openings"
 *   lever       404 — honest
 *   recruitee   404 — honest
 *
 * So the checker is three-valued, and the third value is the point: a link is `dead` only on
 * positive evidence (a bad status, or a platform's own gone-marker), `live` only on positive
 * evidence (that platform's job-page fingerprint), and `unverifiable` otherwise. Nothing is
 * ever assumed live — reporting green on a page we could not read is the exact failure mode
 * finding H describes.
 *
 *   npm run linkcheck
 *   npm run linkcheck -- --limit=200      check a sample instead of the whole DB
 *   npm run linkcheck -- --dry-run        report only, do not mark anything delisted
 */

import { pathToFileURL } from 'node:url';

import { eq, isNull } from 'drizzle-orm';

import { openDb, type Db } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import {
  BlockedAddressError,
  createRuntime,
  HttpError,
  RobotsDisallowedError,
  safeUrl,
  type FetchOptions,
  type Runtime,
} from '../lib/runtime.ts';

export type Verdict = 'live' | 'dead' | 'unverifiable';

export interface LinkResult {
  id: number;
  url: string;
  verdict: Verdict;
  /** HTTP status when we got one, else null (network error, timeout, robots refusal). */
  status: number | null;
  /** Why this verdict — the marker that matched, or what went wrong. */
  reason: string;
}

// ---------------------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------------------

/**
 * Schema.org JSON-LD is the strongest live signal there is: a page that still describes
 * itself as a JobPosting is still serving the posting. Lever, Ashby and Recruitee all emit
 * it on a live job page and none of them emit it on their gone page.
 *
 * Recruitee is covered by this and by its 404 rather than by a host rule, because Recruitee
 * career sites run on the customer's own domain (`werkenbijsparkles.io`) and there is no
 * host pattern to match.
 */
const JOB_POSTING_LD = /"@type"\s*:\s*"JobPosting"/i;

interface Platform {
  name: string;
  /** Matched against the hostname, anchored so `evilgreenhouse.io` cannot claim the rules. */
  host: RegExp;
  /** Positive evidence the posting is GONE, even under a 200. */
  gone?: { pattern: RegExp; label: string }[];
  /** Positive evidence the page is still a job page, beyond the generic JSON-LD test. */
  live?: { pattern: RegExp; label: string }[];
}

const PLATFORMS: Platform[] = [
  {
    name: 'greenhouse',
    host: /(^|\.)greenhouse\.io$/i,
    // The error redirect lands on the board index, whose title is "Jobs at <Company>".
    gone: [{ pattern: /<title>\s*Jobs at /i, label: 'greenhouse: redirected to the board index' }],
    live: [
      { pattern: /<title>\s*Job Application for /i, label: 'greenhouse: application page title' },
      { pattern: /class="[^"]*application--form/i, label: 'greenhouse: application form' },
    ],
  },
  {
    name: 'lever',
    host: /(^|\.)lever\.co$/i,
    gone: [{ pattern: /<title>\s*Not found/i, label: 'lever: not-found page' }],
    live: [{ pattern: /data-qa="job-description"|posting-headline/i, label: 'lever: posting body' }],
  },
  {
    name: 'ashby',
    host: /(^|\.)ashbyhq\.com$/i,
    // A live Ashby page titles itself "<Role> @ <Company>"; the gone shell is bare "Jobs".
    gone: [{ pattern: /<title>\s*Jobs\s*<\/title>/i, label: 'ashby: empty app shell' }],
  },
  {
    name: 'workable',
    host: /(^|\.)workable\.com$/i,
    gone: [
      { pattern: /<title>\s*Workable\s*<\/title>/i, label: 'workable: fallback shell title' },
      {
        pattern: /property="og:title"\s+content="Current Openings"/i,
        label: 'workable: bounced to the openings list',
      },
    ],
    // No positive live fingerprint found on apply.workable.com — its live and gone pages are
    // the same shell with a different title. Live Workable links therefore come back
    // `unverifiable`, which is the honest answer rather than an assumed green.
  },
];

export function platformFor(url: string): Platform | null {
  try {
    const { hostname } = new URL(url);
    return PLATFORMS.find((platform) => platform.host.test(hostname)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Body-based verdict for a URL that answered 200. Gone-markers are checked BEFORE
 * live-markers: a page can carry both (a board index lists job cards) and "gone" is the
 * claim that must never be missed.
 */
export function classifyBody(url: string, body: string): { verdict: Verdict; reason: string } {
  const platform = platformFor(url);

  for (const marker of platform?.gone ?? []) {
    if (marker.pattern.test(body)) return { verdict: 'dead', reason: marker.label };
  }
  for (const marker of platform?.live ?? []) {
    if (marker.pattern.test(body)) return { verdict: 'live', reason: marker.label };
  }
  if (JOB_POSTING_LD.test(body)) return { verdict: 'live', reason: 'JobPosting metadata present' };

  return {
    verdict: 'unverifiable',
    reason: platform
      ? `200 from ${platform.name}, no live or gone marker matched`
      : '200 from an unrecognised host, no JobPosting metadata',
  };
}

// ---------------------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------------------

/** HEAD is not universally implemented; a refusal to answer it says nothing about the job. */
const HEAD_NOT_SUPPORTED = new Set([403, 405, 501]);

/**
 * The only statuses that positively mean "this posting is gone".
 *
 * Everything else non-2xx is `unverifiable`, and the distinction matters because a `dead`
 * verdict writes `delisted_at` and removes the posting from both tabs. A real 500-link run
 * found the counterexamples: news.ycombinator.com answered **429** to a burst of checks and
 * epicgames.com answered **403** to a bot — thirteen live postings that a "non-200 is dead"
 * rule would have delisted. Rate-limited and bot-blocked are not gone.
 */
const GONE_STATUS = new Set([404, 410]);

function failure(error: unknown): { status: number | null; reason: string } {
  if (error instanceof HttpError) return { status: error.status, reason: `HTTP ${error.status}` };
  if (error instanceof RobotsDisallowedError) return { status: null, reason: 'robots.txt disallows checking it' };
  if (error instanceof BlockedAddressError) return { status: null, reason: error.message };
  return { status: null, reason: error instanceof Error ? error.message : String(error) };
}

/**
 * One link: HEAD for the status, then GET only when a 200 means the body has to decide. A
 * non-200 already settles it one way or the other, so no body is downloaded for those.
 *
 * `publicOnly` is the important flag here and the reason this file cannot just call `fetch`:
 * the URL is whatever a job board put in the posting, so every hop is a destination we did
 * not choose.
 */
export async function checkLink(
  runtime: Runtime,
  posting: { id: number; url: string },
): Promise<LinkResult> {
  const { id, url } = posting;
  const options: FetchOptions = { retries: 1, timeoutMs: 15_000, publicOnly: true };

  const verdictFor = (status: number | null): Verdict =>
    status !== null && GONE_STATUS.has(status) ? 'dead' : 'unverifiable';

  try {
    await runtime.fetchText(url, { ...options, method: 'HEAD' });
  } catch (error) {
    const { status, reason } = failure(error);
    if (status === null || !HEAD_NOT_SUPPORTED.has(status)) {
      // A network error, a timeout, a 429 or a 403 is not evidence the posting is gone.
      return { id, url, verdict: verdictFor(status), status, reason };
    }
    // 403/405/501 on HEAD: fall through and ask for the body instead.
  }

  try {
    const body = await runtime.fetchText(url, { ...options, method: 'GET' });
    const { verdict, reason } = classifyBody(url, body);
    return { id, url, verdict, status: 200, reason };
  } catch (error) {
    const { status, reason } = failure(error);
    return { id, url, verdict: verdictFor(status), status, reason };
  }
}

export interface LinkcheckOptions {
  limit?: number;
  /** Report only — do not write `delisted_at`. */
  dryRun?: boolean;
  concurrency?: number;
  log?: (record: Record<string, unknown>) => void;
}

export interface LinkcheckSummary {
  checked: number;
  live: number;
  dead: number;
  unverifiable: number;
  marked: number;
  results: LinkResult[];
}

export async function runLinkcheck(
  db: Db,
  runtime: Runtime,
  options: LinkcheckOptions = {},
): Promise<LinkcheckSummary> {
  const log = options.log ?? ((record) => console.log(JSON.stringify(record)));
  const concurrency = options.concurrency ?? 8;

  // Already-delisted postings are not re-checked: they are out of the UI either way, and the
  // point of the run is the links a user can still click.
  const base = db
    .select({ id: postings.id, url: postings.canonicalUrl })
    .from(postings)
    .where(isNull(postings.delistedAt));
  const queue = (options.limit === undefined ? base : base.limit(options.limit)).all();

  const total = queue.length;
  const results: LinkResult[] = [];

  await Promise.all(
    Array.from({ length: Math.min(concurrency, total) }, async () => {
      for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
        const result = await checkLink(runtime, next);
        results.push(result);
        // Dead links are REPORTED, always — never silently dropped (Phase 9 gate).
        if (result.verdict !== 'live') {
          log({
            event: 'linkcheck',
            posting: result.id,
            verdict: result.verdict,
            status: result.status,
            url: safeUrl(result.url),
            reason: result.reason,
          });
        }
      }
    }),
  );

  const dead = results.filter((result) => result.verdict === 'dead');
  let marked = 0;
  if (!options.dryRun && dead.length > 0) {
    // ...and MARKED. `delisted_at` is the schema's existing "not live any more" flag, and
    // lib/query.ts already hides a delisted posting from both tabs and from `?job=<id>`.
    const now = new Date();
    db.transaction((tx) => {
      for (const result of dead) {
        tx.update(postings).set({ delistedAt: now }).where(eq(postings.id, result.id)).run();
        marked += 1;
      }
    });
  }

  return {
    checked: results.length,
    live: results.filter((result) => result.verdict === 'live').length,
    dead: dead.length,
    unverifiable: results.filter((result) => result.verdict === 'unverifiable').length,
    marked,
    results,
  };
}

export function formatSummary(summary: LinkcheckSummary, dryRun: boolean): string {
  return [
    `linkcheck: ${summary.checked} checked`,
    `${summary.live} live`,
    `${summary.dead} dead${dryRun ? ' (not marked, --dry-run)' : ` (marked delisted: ${summary.marked})`}`,
    `${summary.unverifiable} unverifiable`,
  ].join(', ');
}

// ---------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------

function flag(argv: string[], name: string): string | undefined {
  const match = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (match === undefined) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const dryRun = flag(argv, 'dry-run') !== undefined;
  const rawLimit = flag(argv, 'limit');
  const limit = rawLimit === undefined || rawLimit === '' ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new Error(`bad --limit: ${rawLimit}`);

  const db = openDb();
  const summary = await runLinkcheck(db, createRuntime(), { limit, dryRun });
  console.log(formatSummary(summary, dryRun));

  // A dead link is a real finding, not a crash: exit 1 so a cron wrapper can notice.
  return summary.dead > 0 ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
