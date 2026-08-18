/**
 * GitHub README table parser (plan Phase 6) — SimplifyJobs' internship list.
 * `source_priority = 5`, the lowest: these rows point at someone else's apply link and carry
 * no description, so any other source for the same job outranks them for `canonical_url`.
 *
 * The list is an HTML `<table>` inside README.md (it stopped being a markdown pipe table),
 * with `↳` in the company cell meaning "same company as the row above".
 *
 * NOTE: the repo is renamed every year (Summer2026 -> Summer2027 -> ...). GitHub keeps the
 * old name redirecting, so this URL survives a rename; a brand-new repo would not, and the
 * connector would then fail loudly rather than quietly returning nothing.
 */

import type { Connector, ConnectorPosting } from '../../lib/runtime.ts';

const README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md';

const DAY_MS = 24 * 60 * 60 * 1000;

function text(cell: string): string {
  return cell
    .replace(/<[^>]*>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** "0d" · "12d" · "1mo" · "3mo" — the only shapes the list uses. */
export function ageToPostedAt(age: string, now: number): number {
  const match = /^(\d+)\s*(d|mo)$/i.exec(age.trim());
  if (!match) return Number.NaN;
  const amount = Number(match[1]);
  return now - amount * (match[2].toLowerCase() === 'mo' ? 30 * DAY_MS : DAY_MS);
}

/** Strips Simplify's referral params so the same row yields the same URL on every run. */
function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url.replace(/&amp;/g, '&'));
    for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'ref']) {
      parsed.searchParams.delete(key);
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Exported for the offline test — pure, so it needs no fixture plumbing of its own. */
export function parseReadmeTable(markdown: string, now: number): ConnectorPosting[] {
  const postings: ConnectorPosting[] = [];
  let company = '';

  for (const [, tr] of markdown.matchAll(/<tr>([^]*?)<\/tr>/gi)) {
    const cells = [...tr.matchAll(/<td>([^]*?)<\/td>/gi)].map((match) => match[1]);
    if (cells.length < 4) continue;

    const cellCompany = text(cells[0]);
    // "↳" carries the previous row's company down; a row before the first named one is junk.
    if (cellCompany && cellCompany !== '↳') company = cellCompany;
    if (!company) continue;

    // The apply cell holds the employer link first and Simplify's own mirror second. Rows
    // for closed roles have no link at all.
    const href = /<a\s+href="([^"]+)"/i.exec(cells[3]);
    if (!href) continue;

    postings.push({
      source: 'simplify-internships',
      sourceKind: 'repo',
      sourceUrl: cleanUrl(href[1]),
      postedAt: ageToPostedAt(text(cells[4] ?? ''), now),
      company,
      title: text(cells[1]),
      location: text(cells[2]) || null,
      // The list has no job body. Every other tier does, and when this row merges with one
      // of them the description arrives from there; on its own it stays empty rather than
      // being padded out with the row's own cells restated as prose.
      description: '',
    });
  }

  return postings;
}

export const simplifyInternships: Connector = {
  name: 'simplify-internships',
  kind: 'repo',
  // A hand-maintained GitHub README. It takes a few commits a day; three hours keeps us
  // within one edit of current without re-downloading an unchanged file 48 times.
  minIntervalMs: 3 * 60 * 60 * 1000,
  async fetch(context) {
    const markdown = await context.runtime.fetchText(README_URL);
    const postings = parseReadmeTable(markdown, Date.now());
    if (postings.length === 0) throw new Error('README parsed but yielded no rows');
    return postings;
  },
};

/**
 * YC IS DEFERRED, and for the same reason Workday is (see `ats.ts`).
 *
 * The public YC directory JSON (`yc-oss.github.io/api/companies/*.json`) is a COMPANY
 * directory — name, batch, website, `isHiring` — with no postings in it. Work at a Startup's
 * job data is behind a session. Emitting one "posting" per YC company would be fabricating
 * rows, and the plan's own anti-pattern list says to prefer the ATS endpoint anyway: the 46
 * YC companies already in `companies.json` were resolved from that exact directory by
 * `scripts/resolve-companies.ts` and are polled through the Ashby/Greenhouse connectors,
 * which is where their real postings come from.
 */

export const repoConnectors: Connector[] = [simplifyInternships];
