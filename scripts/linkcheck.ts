/**
 * `npm run linkcheck` — does every stored apply link still lead to a live posting?
 *
 * The acceptance criterion is "every apply link resolves to a LIVE posting", and finding H
 * in plans/workie.md is the reason this is not a status-code script: several ATS platforms
 * answer 200 for a job that is gone. Verified against the live platforms on 2026-08-18:
 *
 *   greenhouse  a withdrawn job 302s to the board index and answers **200**
 *               (`/twilio/jobs/1` -> `/twilio?error=true`, `<title>Jobs at Twilio</title>`)
 *   ashby       both live and unknown jobs can answer **200** with a bare SPA shell;
 *               the official posting API must resolve that ambiguity
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

import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';

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
const NO_SIGNAL_HOSTS = new Set(['news.ycombinator.com']);

const ashbyBoards = new WeakMap<Runtime, Map<string, Promise<Map<string, boolean> | null>>>();

function ashbyIdentity(raw: string): { board: string; id: string } | null {
  try {
    const url = new URL(raw);
    const match = /^\/([^/]+)\/([a-f0-9-]{36})(?:\/application)?\/?$/i.exec(url.pathname);
    return url.hostname === 'jobs.ashbyhq.com' && match
      ? { board: match[1], id: match[2].toLowerCase() }
      : null;
  } catch {
    return null;
  }
}

async function ashbyPresence(runtime: Runtime, url: string, options: FetchOptions): Promise<boolean | null> {
  const identity = ashbyIdentity(url);
  if (!identity) return null;
  let boards = ashbyBoards.get(runtime);
  if (!boards) ashbyBoards.set(runtime, boards = new Map());
  if (!boards.has(identity.board)) {
    boards.set(identity.board, (async () => {
      try {
        const body = await runtime.fetchJson<{ jobs?: unknown[] }>(
          `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(identity.board)}`,
          options,
        );
        // An empty or malformed board can be an outage, not hundreds of closed jobs.
        if (!Array.isArray(body.jobs) || body.jobs.length === 0) return null;
        const listed = new Map<string, boolean>();
        for (const value of body.jobs) {
          if (!value || typeof value !== 'object') return null;
          const job = value as { jobUrl?: unknown; isListed?: unknown };
          const parsed = typeof job.jobUrl === 'string' ? ashbyIdentity(job.jobUrl) : null;
          if (!parsed || parsed.board !== identity.board || typeof job.isListed !== 'boolean') return null;
          listed.set(parsed.id, job.isListed);
        }
        return listed;
      } catch {
        return null;
      }
    })());
  }
  const listed = await boards.get(identity.board)!;
  if (!listed) return null;
  // Unlisted roles may still accept direct applications; that is not a closed-job signal.
  return listed.has(identity.id) ? (listed.get(identity.id) ? true : null) : false;
}

export async function checkLink(
  runtime: Runtime,
  posting: { id: number; url: string },
): Promise<LinkResult> {
  const { id, url } = posting;

  // Hosts whose checks carry no signal at any price. news.ycombinator.com answers 429
  // behind a 30-second crawl-delay, and an HN thread item does not 404 when the job dies —
  // 153 of these burned ~76 of the run's 90 budgeted minutes, the alarm killed the run,
  // and the single end-of-run transaction meant linkcheck had never delisted anything
  // (every cycle log: exit=142). Unverifiable without a request.
  try {
    if (NO_SIGNAL_HOSTS.has(new URL(url).hostname)) {
      return { id, url, verdict: 'unverifiable', status: null, reason: 'no-signal host' };
    }
  } catch {
    return { id, url, verdict: 'unverifiable', status: null, reason: 'unparseable URL' };
  }

  const options: FetchOptions = { retries: 1, timeoutMs: 15_000, publicOnly: true };

  const verdictFor = (status: number | null): Verdict =>
    status !== null && GONE_STATUS.has(status) ? 'dead' : 'unverifiable';

  try {
    await runtime.fetchText(url, { ...options, method: 'HEAD' });
  } catch (error) {
    const { status, reason } = failure(error);
    if (status === null || !HEAD_NOT_SUPPORTED.has(status)) {
      // A network error, a timeout or a 429 is not evidence the posting is gone. (403 is
      // NOT handled here - it is in HEAD_NOT_SUPPORTED and takes the fall-through below.)
      return { id, url, verdict: verdictFor(status), status, reason };
    }
    // 403/405/501 on HEAD: fall through and ask for the body instead.
  }

  try {
    const body = await runtime.fetchText(url, { ...options, method: 'GET' });
    const { verdict, reason } = classifyBody(url, body);
    if (verdict === 'unverifiable' && /<title>\s*Jobs\s*<\/title>/i.test(body)) {
      const listed = await ashbyPresence(runtime, url, options);
      if (listed !== null) {
        return {
          id, url, status: 200,
          verdict: listed ? 'unverifiable' : 'dead',
          reason: listed ? 'ashby: API lists role, application page unverified' : 'ashby: absent from official API',
        };
      }
    }
    return { id, url, verdict, status: 200, reason };
  } catch (error) {
    const { status, reason } = failure(error);
    return { id, url, verdict: verdictFor(status), status, reason };
  }
}

export interface LinkcheckOptions {
  limit?: number;
  /** Explicit posting IDs, for a small audited run. Mutually exclusive with `limit`. */
  ids?: readonly number[];
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
  restored: number;
  results: LinkResult[];
}

export async function runLinkcheck(
  db: Db,
  runtime: Runtime,
  options: LinkcheckOptions = {},
): Promise<LinkcheckSummary> {
  const log = options.log ?? ((record) => console.log(JSON.stringify(record)));
  const concurrency = options.concurrency ?? 8;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`concurrency must be a positive integer, received ${concurrency}`);
  }
  if (options.ids !== undefined && options.limit !== undefined) {
    throw new Error('ids and limit cannot be used together');
  }

  // A linkcheck mark is provisional: a board outage or a corrected canonical URL can make a
  // previously dead link live again. Recheck only rows this checker marked itself; ghost
  // delistings remain the ghost pass's ownership. Rows extraction dropped (`track` null) are
  // still out of scope because they have no apply control to validate.
  const recheckable = and(
    isNotNull(postings.track),
    or(isNull(postings.delistedAt), eq(postings.delistedReason, 'linkcheck')),
  );
  const base = db
    .select({ id: postings.id, url: postings.canonicalUrl, delistedReason: postings.delistedReason })
    .from(postings);
  let queue: { id: number; url: string; delistedReason: 'ghost' | 'linkcheck' | null }[];

  if (options.ids !== undefined) {
    const ids = [...options.ids];
    if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new Error('ids must contain positive safe integers');
    }
    if (new Set(ids).size !== ids.length) throw new Error('ids must not contain duplicates');

    // Validate the whole requested set before checking or writing any one row. A cloud writer
    // must not delist a prefix and only then discover that an operator mistyped another ID.
    const known = new Set(db.select({ id: postings.id }).from(postings).where(inArray(postings.id, ids)).all().map((r) => r.id));
    const unknown = ids.filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`unknown posting ids: ${unknown.join(',')}`);

    queue = base
      .where(and(recheckable, inArray(postings.id, ids)))
      .all();
    const eligible = new Set(queue.map((row) => row.id));
    const unavailable = ids.filter((id) => !eligible.has(id));
    if (unavailable.length > 0) {
      throw new Error(`posting ids are not currently checkable: ${unavailable.join(',')}`);
    }
  } else {
    queue = (options.limit === undefined ? base.where(recheckable) : base.where(recheckable).limit(options.limit)).all();
  }

  const total = queue.length;
  const priorReason = new Map(queue.map((row) => [row.id, row.delistedReason]));
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
  let restored = 0;
  if (!options.dryRun && (dead.length > 0 || results.some((result) => result.verdict === 'live'))) {
    const now = new Date();
    db.transaction((tx) => {
      for (const result of dead) {
        // Existing linkcheck delistings retain their original timestamp. Only an active row
        // gets a new mark, and ghost-owned rows were excluded before this point.
        if (priorReason.get(result.id) === 'linkcheck') continue;
        const update = tx.update(postings)
          .set({ delistedAt: now, delistedReason: 'linkcheck' })
          .where(and(eq(postings.id, result.id), isNull(postings.delistedAt)))
          .run();
        marked += update.changes;
      }
      for (const result of results) {
        if (result.verdict !== 'live' || priorReason.get(result.id) !== 'linkcheck') continue;
        const update = tx.update(postings)
          .set({ delistedAt: null, delistedReason: null })
          .where(
            and(
              eq(postings.id, result.id),
              eq(postings.delistedReason, 'linkcheck'),
              isNotNull(postings.delistedAt),
            ),
          )
          .run();
        restored += update.changes;
      }
    });
  }

  return {
    checked: results.length,
    live: results.filter((result) => result.verdict === 'live').length,
    dead: dead.length,
    unverifiable: results.filter((result) => result.verdict === 'unverifiable').length,
    marked,
    restored,
    results,
  };
}

export function formatSummary(summary: LinkcheckSummary, dryRun: boolean): string {
  return [
    `linkcheck: ${summary.checked} checked`,
    `${summary.live} live`,
    `${summary.dead} dead${dryRun ? ' (not marked, --dry-run)' : ` (marked delisted: ${summary.marked})`}`,
    `${summary.restored} restored`,
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

/** Strict CLI grammar: positive decimal SQLite IDs, comma-separated, no whitespace or dupes. */
export function parseAuditedIds(raw: string): number[] {
  if (!/^[1-9]\d*(?:,[1-9]\d*)*$/.test(raw)) throw new Error(`bad --ids: ${raw}`);
  const ids = raw.split(',').map(Number);
  if (ids.some((id) => !Number.isSafeInteger(id) || id > 2_147_483_647)) throw new Error(`bad --ids: ${raw}`);
  if (new Set(ids).size !== ids.length) throw new Error(`bad --ids: duplicate id`);
  return ids;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const dryRun = flag(argv, 'dry-run') !== undefined;
  const rawLimit = flag(argv, 'limit');
  const limit = rawLimit === undefined || rawLimit === '' ? undefined : Number.parseInt(rawLimit, 10);
  if (limit !== undefined && (!Number.isFinite(limit) || limit <= 0)) throw new Error(`bad --limit: ${rawLimit}`);
  const rawIds = flag(argv, 'ids');
  const ids = rawIds === undefined ? undefined : parseAuditedIds(rawIds);
  if (ids !== undefined && rawLimit !== undefined) throw new Error('--ids cannot be combined with --limit');

  const db = openDb();
  const summary = await runLinkcheck(db, createRuntime(), { limit, ids, dryRun });
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
