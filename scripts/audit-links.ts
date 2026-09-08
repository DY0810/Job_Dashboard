/**
 * Read-only production audit for the links the Workie UI currently renders.
 *
 * This is deliberately separate from `linkcheck`: it does not open a database and cannot
 * write `delisted_at`. The historical board rendered 200 rows per page; the follow-up paginator
 * now traverses pages under an explicit page cap and total scheduling budget.
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
export const DEFAULT_MAX_PAGES = 20;
export const DEFAULT_TIME_BUDGET_SECONDS = 20 * 60;
const MAX_MAX_PAGES = 100;
const MAX_TIME_BUDGET_SECONDS = 2 * 60 * 60;
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
export type ApiCheck = 'match' | 'mismatch' | 'unavailable' | 'not-checked';

interface RenderedLink {
  id: number;
  url: string;
}

export interface RenderedLinkDiscovery {
  links: RenderedLink[];
  expectedApplyCells: number;
  pairedApplyCells: number;
  unpairedApplyCells: number;
}

interface AuditResult {
  view: string;
  id: number;
  url: string;
  api: ApiCheck;
  outcome: Outcome;
  status: number | null;
  reason: string;
}

interface ViewSummary {
  view: string;
  pagesFetched: number;
  paginationState: 'complete' | 'next-link-absent' | 'partial';
  uniqueLinks: number;
  rendered: number;
  duplicateIds: number;
  duplicateIdValues: number[];
  expectedApplyCells: number;
  pairedApplyCells: number;
  unpairedApplyCells: number;
  partial: boolean;
  partialReason: string | null;
  apiMatches: number;
  apiMismatches: number;
  apiUnavailable: number;
  apiNotChecked: number;
  live: number;
  dead: number;
  blocked: number;
  unknown: number;
  samples: AuditResult[];
  results: AuditResult[];
}

function flag(argv: string[], name: string): string | undefined {
  const match = argv.find((arg) => arg === `--${name}` || arg.startsWith(`--${name}=`));
  if (!match) return undefined;
  return match.includes('=') ? match.slice(match.indexOf('=') + 1) : '';
}

export function parseBoundedPositiveInt(raw: string | undefined, name: string, fallback: number, max: number): number {
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw)) throw new Error(`bad --${name}: ${raw}`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value > max) throw new Error(`bad --${name}: ${raw}`);
  return value;
}

function htmlDecode(value: string): string {
  return value.replace(/&amp;/g, '&').replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
}

function combineReasons(...reasons: (string | null)[]): string | null {
  const present = reasons.filter((reason): reason is string => reason !== null);
  return present.length > 0 ? present.join('; ') : null;
}

function attr(openingTag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(openingTag);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

function anchorLink(anchor: string): RenderedLink | null {
  const opening = /^<a\b[^>]*>/i.exec(anchor)?.[0];
  if (!opening) return null;
  const id = attr(opening, 'data-posting-id');
  const href = attr(opening, 'href');
  if (!id || !/^[1-9]\d*$/.test(id) || !href || !/^https?:\/\//i.test(href)) return null;
  return { id: Number(id), url: htmlDecode(href) };
}

function legacyRowLink(row: string): RenderedLink | null {
  if (/\bdata-posting-id=/i.test(row)) return null;
  const id = /href="\/\?(?:job=|[^"]*&amp;job=)(\d+)/.exec(row)?.[1];
  const anchors = row.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
  const apply = anchors.find((anchor) => {
    const opening = /^<a\b[^>]*>/i.exec(anchor)?.[0] ?? '';
    const classes = attr(opening, 'class')?.split(/\s+/) ?? [];
    return classes.includes('chip') && /^<a\b[^>]*>\s*apply\b/i.test(anchor);
  });
  const href = apply ? attr(/^<a\b[^>]*>/i.exec(apply)?.[0] ?? '', 'href') : null;
  if (!id || !href || !/^https?:\/\//i.test(href)) return null;
  return { id: Number(id), url: htmlDecode(href) };
}

/**
 * Prefer the explicit marker added to Apply anchors. React may stream that cell after the
 * table row that held the job ID, so sibling traversal is not reliable. The legacy row parser
 * remains only for older, unmarked markup.
 */
export function renderedLinkDiscovery(html: string): RenderedLinkDiscovery {
  const links: RenderedLink[] = [];
  const applyCells = html.match(/<td\b[^>]*\bdata-field=(?:"apply"|'apply')[^>]*>[\s\S]*?<\/td>/gi) ?? [];
  let pairedApplyCells = 0;

  for (const cell of applyCells) {
    const anchors = cell.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) ?? [];
    const marked = anchors.map(anchorLink).filter((link): link is RenderedLink => link !== null);
    if (marked.length === 1) {
      links.push(marked[0]);
      pairedApplyCells += 1;
    }
  }

  const rows = html.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/g) ?? [];
  for (const row of rows) {
    const link = legacyRowLink(row);
    if (link) {
      links.push(link);
      if (/\bdata-field=(?:"apply"|'apply')/i.test(row)) pairedApplyCells += 1;
    }
  }
  return {
    links,
    expectedApplyCells: applyCells.length,
    pairedApplyCells,
    unpairedApplyCells: Math.max(0, applyCells.length - pairedApplyCells),
  };
}

export function renderedLinks(html: string): RenderedLink[] {
  return renderedLinkDiscovery(html).links;
}

export function duplicateIds(links: readonly RenderedLink[]): number[] {
  const counts = new Map<number, number>();
  for (const link of links) counts.set(link.id, (counts.get(link.id) ?? 0) + 1);
  return [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((a, b) => a - b);
}

export function duplicateCoverage(links: readonly RenderedLink[]): {
  duplicateIdValues: number[];
  partial: boolean;
  partialReason: string | null;
} {
  const duplicateIdValues = duplicateIds(links);
  return {
    duplicateIdValues,
    partial: duplicateIdValues.length > 0,
    partialReason:
      duplicateIdValues.length > 0
        ? `duplicate posting IDs across rendered pages: ${duplicateIdValues.join(',')}`
        : null,
  };
}

export function countApiChecks(results: readonly { api: ApiCheck }[]): {
  apiMatches: number;
  apiMismatches: number;
  apiUnavailable: number;
  apiNotChecked: number;
} {
  return results.reduce(
    (counts, result) => {
      if (result.api === 'match') counts.apiMatches += 1;
      else if (result.api === 'mismatch') counts.apiMismatches += 1;
      else if (result.api === 'unavailable') counts.apiUnavailable += 1;
      else counts.apiNotChecked += 1;
      return counts;
    },
    { apiMatches: 0, apiMismatches: 0, apiUnavailable: 0, apiNotChecked: 0 },
  );
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

async function each<T>(
  items: readonly T[],
  deadline: number,
  fn: (item: T, expired: boolean) => Promise<void>,
): Promise<void> {
  // This is a scheduling cutoff, not an abort-all deadline: work already started is bounded
  // by its own request timeout and is allowed to settle so its verdict is retained.
  const queue = [...items];
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
        await fn(item, Date.now() >= deadline);
      }
    }),
  );
}

async function apiMatches(
  base: string,
  link: RenderedLink,
  deadline: number,
): Promise<ApiCheck> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) return 'not-checked';
  try {
    const response = await fetch(new URL(`/api/postings/${link.id}`, base), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(Math.min(15_000, remaining)),
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
  maxPages: number,
  deadline: number,
): Promise<{
  links: RenderedLink[];
  expectedApplyCells: number;
  pairedApplyCells: number;
  unpairedApplyCells: number;
  pagesFetched: number;
  paginationState: ViewSummary['paginationState'];
  partial: boolean;
  partialReason: string | null;
}> {
  const origin = new URL(base);
  const seenPages = new Set<string>();
  const links: RenderedLink[] = [];
  let expectedApplyCells = 0;
  let pairedApplyCells = 0;
  let unpairedApplyCells = 0;
  let next: string | null = path;
  let pagesFetched = 0;
  let partialReason: string | null = null;
  let sawNext = false;

  while (next !== null && pagesFetched < maxPages) {
    if (Date.now() >= deadline) {
      partialReason = 'time budget exhausted during page discovery';
      break;
    }
    const pageUrl = new URL(next, origin);
    if (seenPages.has(pageUrl.toString())) {
      partialReason = 'pagination loop detected';
      break;
    }
    seenPages.add(pageUrl.toString());
    let html: string;
    try {
      const response = await fetch(pageUrl, {
        headers: { Accept: 'text/html' },
        signal: AbortSignal.timeout(Math.min(20_000, deadline - Date.now())),
      });
      if (!response.ok) {
        partialReason = `page fetch returned HTTP ${response.status}`;
        break;
      }
      html = await response.text();
    } catch (error) {
      partialReason = `page fetch failed: ${error instanceof Error ? error.message : String(error)}`;
      break;
    }
    const discovered = renderedLinkDiscovery(html);
    links.push(...discovered.links);
    expectedApplyCells += discovered.expectedApplyCells;
    pairedApplyCells += discovered.pairedApplyCells;
    unpairedApplyCells += discovered.unpairedApplyCells;
    pagesFetched += 1;
    next = nextBoardPath(html, pageUrl, origin);
    sawNext ||= next !== null;
  }

  if (next !== null && partialReason === null) {
    partialReason = `page cap reached (${maxPages})`;
  }
  return {
    links,
    expectedApplyCells,
    pairedApplyCells,
    unpairedApplyCells,
    pagesFetched,
    paginationState: partialReason !== null ? 'partial' : sawNext ? 'complete' : 'next-link-absent',
    partial: partialReason !== null,
    partialReason,
  };
}

async function auditView(
  base: string,
  name: string,
  path: string,
  maxPages: number,
  deadline: number,
): Promise<ViewSummary> {
  const rendered = await renderedViewLinks(base, name, path, maxPages, deadline);
  const links = rendered.links;
  const duplicate = duplicateCoverage(links);
  const unpairedReason =
    rendered.unpairedApplyCells > 0
      ? `unpaired Apply cells: ${rendered.unpairedApplyCells}/${rendered.expectedApplyCells}`
      : null;
  const unique = new Map<string, RenderedLink>();
  for (const link of links) unique.set(`${link.id}\u0000${link.url}`, link);
  const summary: ViewSummary = {
    view: name,
    pagesFetched: rendered.pagesFetched,
    paginationState: rendered.paginationState,
    uniqueLinks: unique.size,
    rendered: links.length,
    duplicateIds: links.length - new Set(links.map((link) => link.id)).size,
    duplicateIdValues: duplicate.duplicateIdValues,
    expectedApplyCells: rendered.expectedApplyCells,
    pairedApplyCells: rendered.pairedApplyCells,
    unpairedApplyCells: rendered.unpairedApplyCells,
    partial: rendered.partial || duplicate.partial || unpairedReason !== null,
    partialReason: combineReasons(rendered.partialReason, duplicate.partialReason, unpairedReason),
    apiMatches: 0,
    apiMismatches: 0,
    apiUnavailable: 0,
    apiNotChecked: 0,
    live: 0,
    dead: 0,
    blocked: 0,
    unknown: 0,
    samples: [],
    results: [],
  };
  const runtime = createRuntime({ minGapMs: 500, burst: 1, timeoutMs: 15_000, retries: 1 });
  const uniqueResults = new Map<string, AuditResult>();

  await each([...unique.values()], deadline, async (link, expired) => {
    const key = `${link.id}\u0000${link.url}`;
    if (expired) {
      uniqueResults.set(key, {
        view: name,
        id: link.id,
        url: safeUrl(link.url),
        api: 'not-checked',
        outcome: 'unknown',
        status: null,
        reason: 'audit time budget exhausted before verification',
      });
      return;
    }

    const api = await apiMatches(base, link, deadline);
    if (prohibited(link.url)) {
      uniqueResults.set(key, {
        view: name,
        id: link.id,
        url: safeUrl(link.url),
        api,
        outcome: 'blocked',
        status: null,
        reason: 'prohibited host; not requested',
      });
      return;
    }

    if (api === 'not-checked' || Date.now() >= deadline) {
      uniqueResults.set(key, {
        view: name,
        id: link.id,
        url: safeUrl(link.url),
        api,
        outcome: 'unknown',
        status: null,
        reason: 'audit time budget exhausted before link verification',
      });
      return;
    }

    const checked = await checkLink(runtime, link);
    uniqueResults.set(key, {
      view: name,
      id: link.id,
      url: safeUrl(link.url),
      api,
      outcome: outcome(checked),
      status: checked.status,
      reason: checked.reason,
    });
  });

  const results = links.map((link) => uniqueResults.get(`${link.id}\u0000${link.url}`)!);
  Object.assign(summary, countApiChecks([...uniqueResults.values()]));
  for (const result of results) summary[result.outcome] += 1;
  summary.samples = [
    ...results.filter((result) => result.outcome === 'dead'),
    ...results.filter((result) => result.outcome !== 'live' && result.outcome !== 'dead'),
  ].slice(0, 12);
  summary.results = results;
  if (Date.now() >= deadline) {
    summary.partial = true;
    summary.partialReason = combineReasons(summary.partialReason, 'time budget exhausted during link verification');
  }
  if (summary.partial) {
    summary.paginationState = 'partial';
  }
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
  const maxPages = parseBoundedPositiveInt(
    flag(argv, 'max-pages'),
    'max-pages',
    DEFAULT_MAX_PAGES,
    MAX_MAX_PAGES,
  );
  const timeBudgetSeconds = parseBoundedPositiveInt(
    flag(argv, 'time-budget-seconds'),
    'time-budget-seconds',
    DEFAULT_TIME_BUDGET_SECONDS,
    MAX_TIME_BUDGET_SECONDS,
  );
  const views = requestedView ? VIEWS.filter((view) => view.name === requestedView) : VIEWS;
  if (views.length === 0) throw new Error(`unknown --view: ${requestedView}`);
  const startedAt = Date.now();
  const deadline = startedAt + timeBudgetSeconds * 1000;
  const summaries: ViewSummary[] = [];
  for (const view of views) {
    if (Date.now() >= deadline) {
      summaries.push({
        view: view.name,
        pagesFetched: 0,
        paginationState: 'partial',
        uniqueLinks: 0,
        rendered: 0,
        duplicateIds: 0,
        duplicateIdValues: [],
        expectedApplyCells: 0,
        pairedApplyCells: 0,
        unpairedApplyCells: 0,
        partial: true,
        partialReason: 'time budget exhausted before view discovery',
        apiMatches: 0,
        apiMismatches: 0,
        apiUnavailable: 0,
        apiNotChecked: 0,
        live: 0,
        dead: 0,
        blocked: 0,
        unknown: 0,
        samples: [],
        results: [],
      });
      continue;
    }
    summaries.push(await auditView(base, view.name, view.path, maxPages, deadline));
  }

  const total = summaries.reduce(
    (all, view) => ({
      pagesFetched: all.pagesFetched + view.pagesFetched,
      uniqueLinks: all.uniqueLinks + view.uniqueLinks,
      rendered: all.rendered + view.rendered,
      expectedApplyCells: all.expectedApplyCells + view.expectedApplyCells,
      pairedApplyCells: all.pairedApplyCells + view.pairedApplyCells,
      unpairedApplyCells: all.unpairedApplyCells + view.unpairedApplyCells,
      apiMatches: all.apiMatches + view.apiMatches,
      apiMismatches: all.apiMismatches + view.apiMismatches,
      apiUnavailable: all.apiUnavailable + view.apiUnavailable,
      apiNotChecked: all.apiNotChecked + view.apiNotChecked,
      live: all.live + view.live,
      dead: all.dead + view.dead,
      blocked: all.blocked + view.blocked,
      unknown: all.unknown + view.unknown,
      partialViews: all.partialViews + Number(view.partial),
    }),
    {
      pagesFetched: 0,
      uniqueLinks: 0,
      rendered: 0,
      expectedApplyCells: 0,
      pairedApplyCells: 0,
      unpairedApplyCells: 0,
      apiMatches: 0,
      apiMismatches: 0,
      apiUnavailable: 0,
      apiNotChecked: 0,
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
    maxPagesPerView: maxPages,
    timeBudgetSeconds,
    elapsedMs: Date.now() - startedAt,
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
