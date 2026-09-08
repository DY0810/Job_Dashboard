/**
 * Read-only production audit for the links the Workie UI currently renders.
 *
 * This is deliberately separate from `linkcheck`: it does not open a database and cannot
 * write `delisted_at`. It audits the three visible board slices from production, capped at
 * the same 200 rows per view as `lib/query.ts`.
 *
 *   node scripts/audit-links.ts
 *   node scripts/audit-links.ts --base=https://job-dashboard-one-sigma.vercel.app
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkLink, type LinkResult } from './linkcheck.ts';
import { createRuntime, safeUrl } from '../lib/runtime.ts';

const DEFAULT_BASE = 'https://job-dashboard-one-sigma.vercel.app';
const PAGE_SIZE = 200;
const MAX_PAGES_PER_VIEW = 2;
const VIEW_CAP = PAGE_SIZE * MAX_PAGES_PER_VIEW;
const CONCURRENCY = 6;

const VIEWS = [
  { name: 'design-employed', path: '/' },
  { name: 'design-freelance', path: '/?basis=freelance' },
  { name: 'engineering', path: '/?tab=engineering' },
] as const;

const PROHIBITED_HOSTS = new Set([
  'linkedin.com',
  'indeed.com',
  'glassdoor.com',
  'ziprecruiter.com',
  'joinhandshake.com',
  'handshake.com',
]);

type Outcome = 'live' | 'dead' | 'blocked' | 'unknown';

interface RenderedLink {
  id: number;
  url: string;
}

interface AuditResult {
  view: string;
  id: number;
  url: string;
  outcome: Outcome;
  status: number | null;
  reason: string;
}

interface ViewSummary {
  view: string;
  pagesFetched: number;
  paginationState: 'complete' | 'next-link-absent' | 'partial';
  rendered: number;
  duplicateIds: number;
  partial: boolean;
  partialReason: string | null;
  apiMatches: number;
  apiMismatches: number;
  apiUnavailable: number;
  live: number;
  dead: number;
  blocked: number;
  unknown: number;
  samples: AuditResult[];
}

function flag(argv: string[], name: string): string | undefined {
  const match = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!match) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

function htmlDecode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

/**
 * A row's detail link is stable markup and sits before its apply link. Parsing only these two
 * anchors avoids retaining descriptions or arbitrary page HTML in the report.
 */
export function renderedLinks(html: string): RenderedLink[] {
  const links: RenderedLink[] = [];
  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];

  for (const row of rows) {
    const id = /href="\/\?(?:job=|[^"]*&amp;job=)(\d+)/.exec(row)?.[1];
    const apply = /<a class="chip" href="(https?:\/\/[^"]+)"[^>]*>apply</.exec(row)?.[1];
    if (!id || !apply) continue;
    links.push({ id: Number(id), url: htmlDecode(apply) });
  }

  return links;
}

/** The deployed board may expose `rel=next` or an ordinary visible Next link. */
export function nextBoardPath(html: string, current: URL, base: URL): string | null {
  const anchors = html.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  for (const anchor of anchors) {
    const href = /\bhref="([^"]+)"/i.exec(anchor)?.[1];
    if (!href) continue;
    const rel = /\brel="([^"]+)"/i.exec(anchor)?.[1]?.toLowerCase() ?? '';
    const label = anchor.replace(/<[^>]+>/g, '').trim().toLowerCase();
    const ariaLabel = /\baria-label="([^"]+)"/i.exec(anchor)?.[1]?.trim().toLowerCase() ?? '';
    if (!rel.split(/\s+/).includes('next') && label !== 'next' && ariaLabel !== 'next') continue;

    const next = new URL(htmlDecode(href), current);
    if (next.origin !== base.origin) return null;
    return `${next.pathname}${next.search}`;
  }
  return null;
}

function prohibited(url: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return [...PROHIBITED_HOSTS].some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

function outcome(result: LinkResult): Outcome {
  if (result.verdict === 'live' || result.verdict === 'dead') return result.verdict;
  if (
    result.reason === 'robots.txt disallows checking it' ||
    result.status === 401 ||
    result.status === 403 ||
    result.status === 429
  ) {
    return 'blocked';
  }
  return 'unknown';
}

async function each<T>(items: readonly T[], fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
    }),
  );
}

async function apiMatches(base: string, link: RenderedLink): Promise<'match' | 'mismatch' | 'unavailable'> {
  try {
    const response = await fetch(new URL(`/api/postings/${link.id}`, base), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return 'unavailable';
    const body = (await response.json()) as { canonicalUrl?: unknown };
    return body.canonicalUrl === link.url ? 'match' : 'mismatch';
  } catch {
    return 'unavailable';
  }
}

async function renderedViewLinks(
  base: string,
  name: string,
  path: string,
): Promise<{
  links: RenderedLink[];
  pagesFetched: number;
  paginationState: ViewSummary['paginationState'];
  partial: boolean;
  partialReason: string | null;
}> {
  const origin = new URL(base);
  const seenPages = new Set<string>();
  const byId = new Map<number, RenderedLink>();
  let next: string | null = path;
  let pagesFetched = 0;
  let partialReason: string | null = null;
  let sawNext = false;

  while (next !== null && pagesFetched < MAX_PAGES_PER_VIEW && byId.size < VIEW_CAP) {
    const pageUrl = new URL(next, origin);
    if (seenPages.has(pageUrl.toString())) {
      partialReason = 'pagination loop detected';
      break;
    }
    seenPages.add(pageUrl.toString());
    const response = await fetch(pageUrl, {
      headers: { Accept: 'text/html' },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`${name} board returned HTTP ${response.status}`);

    const html = await response.text();
    for (const link of renderedLinks(html)) {
      if (byId.size >= VIEW_CAP) break;
      byId.set(link.id, link);
    }
    pagesFetched += 1;
    next = nextBoardPath(html, pageUrl, origin);
    sawNext ||= next !== null;
  }

  if (next !== null && partialReason === null) {
    partialReason = pagesFetched >= MAX_PAGES_PER_VIEW
      ? `page cap reached (${MAX_PAGES_PER_VIEW})`
      : `row cap reached (${VIEW_CAP})`;
  }
  return {
    links: [...byId.values()],
    pagesFetched,
    paginationState: partialReason !== null ? 'partial' : sawNext ? 'complete' : 'next-link-absent',
    partial: partialReason !== null,
    partialReason,
  };
}

async function auditView(base: string, name: string, path: string): Promise<ViewSummary> {
  const rendered = await renderedViewLinks(base, name, path);
  const links = rendered.links;
  const summary: ViewSummary = {
    view: name,
    pagesFetched: rendered.pagesFetched,
    paginationState: rendered.paginationState,
    rendered: links.length,
    duplicateIds: links.length - new Set(links.map((link) => link.id)).size,
    partial: rendered.partial,
    partialReason: rendered.partialReason,
    apiMatches: 0,
    apiMismatches: 0,
    apiUnavailable: 0,
    live: 0,
    dead: 0,
    blocked: 0,
    unknown: 0,
    samples: [],
  };
  const runtime = createRuntime({ minGapMs: 500, burst: 1, timeoutMs: 15_000, retries: 1 });
  const results: AuditResult[] = [];

  await each(links, async (link) => {
    const api = await apiMatches(base, link);
    if (api === 'match') summary.apiMatches += 1;
    else if (api === 'mismatch') summary.apiMismatches += 1;
    else summary.apiUnavailable += 1;

    if (prohibited(link.url)) {
      results.push({
        view: name,
        id: link.id,
        url: safeUrl(link.url),
        outcome: 'blocked',
        status: null,
        reason: 'prohibited host; not requested',
      });
      return;
    }

    const checked = await checkLink(runtime, link);
    results.push({
      view: name,
      id: link.id,
      url: safeUrl(link.url),
      outcome: outcome(checked),
      status: checked.status,
      reason: checked.reason,
    });
  });

  for (const result of results) summary[result.outcome] += 1;
  summary.samples = [
    ...results.filter((result) => result.outcome === 'dead'),
    ...results.filter((result) => result.outcome !== 'live' && result.outcome !== 'dead'),
  ].slice(0, 12);
  return summary;
}

function outputPath(raw: string | undefined): string {
  if (!raw) return resolve(tmpdir(), 'workie-link-audit.json');
  const output = resolve(raw);
  const workspace = resolve(process.cwd());
  const insideWorkspace = relative(workspace, output);
  const underLogs = insideWorkspace === 'logs' || insideWorkspace.startsWith(`logs/`);
  if (insideWorkspace && !insideWorkspace.startsWith('..') && !underLogs) {
    throw new Error('--output must be outside the repository or under ignored logs/');
  }
  return output;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const base = flag(argv, 'base') || DEFAULT_BASE;
  const requestedView = flag(argv, 'view');
  const views = requestedView ? VIEWS.filter((view) => view.name === requestedView) : VIEWS;
  if (views.length === 0) throw new Error(`unknown --view: ${requestedView}`);
  const summaries: ViewSummary[] = [];
  for (const view of views) summaries.push(await auditView(base, view.name, view.path));

  const total = summaries.reduce(
    (all, view) => ({
      pagesFetched: all.pagesFetched + view.pagesFetched,
      rendered: all.rendered + view.rendered,
      apiMatches: all.apiMatches + view.apiMatches,
      apiMismatches: all.apiMismatches + view.apiMismatches,
      apiUnavailable: all.apiUnavailable + view.apiUnavailable,
      live: all.live + view.live,
      dead: all.dead + view.dead,
      blocked: all.blocked + view.blocked,
      unknown: all.unknown + view.unknown,
      partialViews: all.partialViews + Number(view.partial),
    }),
    {
      pagesFetched: 0,
      rendered: 0,
      apiMatches: 0,
      apiMismatches: 0,
      apiUnavailable: 0,
      live: 0,
      dead: 0,
      blocked: 0,
      unknown: 0,
      partialViews: 0,
    },
  );
  const output = outputPath(flag(argv, 'output'));
  const report = {
    event: 'production-link-audit',
    base,
    pageSize: PAGE_SIZE,
    maxPagesPerView: MAX_PAGES_PER_VIEW,
    capPerView: VIEW_CAP,
    total,
    views: summaries,
  };
  await mkdir(resolve(output, '..'), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ event: report.event, output, total, partial: total.partialViews > 0 }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
