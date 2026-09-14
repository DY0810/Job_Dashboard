/**
 * GitHub job lists, including SimplifyJobs' internship and new-grad tables.
 * `source_priority = 5`, the lowest: these rows point at someone else's apply link and carry
 * no description, so any other source for the same job outranks them for `canonical_url`.
 *
 * Simplify supplies raw HTML tables; the other repositories use GitHub-rendered Markdown.
 * `↳` in the company cell means "same company as the row above".
 *
 * The seasonal internship repo is renamed every year. New-Grad Positions is a stable canonical
 * repository on its `dev` branch. A rename or contract change fails loudly rather than silently
 * returning nothing.
 */

import { normalizeDescription } from '../../lib/normalize.ts';
import { redact, type Connector, type ConnectorPosting } from '../../lib/runtime.ts';

const INTERNSHIPS_README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/README.md';
const NEW_GRADS_README_URL =
  'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/README.md';

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

/** Remove tracking, but retain parameters that identify the actual requisition. */
function cleanUrl(url: string): string {
  try {
    const parsed = new URL(url.replace(/&amp;/g, '&'));
    for (const key of [...parsed.searchParams.keys()]) {
      if (/^utm_/i.test(key) || (key === 'ref' && /^simplify$/i.test(parsed.searchParams.get(key) ?? ''))) {
        parsed.searchParams.delete(key);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

/** Exported for the offline test — pure, so it needs no fixture plumbing of its own. */
export function parseReadmeTable(
  markdown: string,
  now: number,
  source: string = 'simplify-internships',
): ConnectorPosting[] {
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
      source,
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
    const markdown = await context.runtime.fetchText(INTERNSHIPS_README_URL);
    const postings = parseReadmeTable(markdown, Date.now());
    if (postings.length === 0) throw new Error('README parsed but yielded no rows');
    return postings;
  },
};

export const simplifyNewGrads: Connector = {
  name: 'simplify-new-grads',
  kind: 'repo',
  minIntervalMs: 3 * 60 * 60 * 1000,
  async fetch(context) {
    const markdown = await context.runtime.fetchText(NEW_GRADS_README_URL);
    const postings = parseReadmeTable(markdown, Date.now(), 'simplify-new-grads');
    if (postings.length === 0) throw new Error('README parsed but yielded no rows');
    return postings;
  },
};

/** Yearless dates refer to publication, not the internship year in the repository name. */
export function repositoryDate(value: string, now: number): number {
  const relative = ageToPostedAt(value, now);
  if (Number.isFinite(relative)) return relative;
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const named = /^([a-z]{3})\s+(\d{1,2})(?:,?\s+(\d{4}))?$/i.exec(value);
  if (!iso && !named) return Number.NaN;
  const month = iso ? Number(iso[2]) - 1
    : ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(named![1].toLowerCase());
  const day = Number(iso?.[3] ?? named?.[2]);
  const explicitYear = iso?.[1] ?? named?.[3];
  const currentYear = new Date(now).getUTCFullYear();
  const years = explicitYear ? [Number(explicitYear)] : [currentYear + 1, currentYear, currentYear - 1];
  for (const year of years) {
    const date = new Date(Date.UTC(year, month, day));
    if (date.getUTCFullYear() === year && date.getUTCMonth() === month && date.getUTCDate() === day
      && date.getTime() <= now + DAY_MS) return date.getTime();
  }
  return Number.NaN;
}

function tableText(value: string): string {
  return normalizeDescription(value
    .replace(/<summary\b[^>]*>([^]*?)<\/summary>/gi, (whole, content: string) =>
      /^\d+\s+locations?$/i.test(normalizeDescription(content)) ? '' : whole)
    .replace(/<\/?br\b[^>]*>/gi, '; '));
}

function applicationLink(cell: string): string | null {
  const href = /<a\b[^>]*\bhref\s*=\s*(["'])([^]*?)\1/i.exec(cell)?.[2];
  if (!href) return null;
  try {
    const url = new URL(cleanUrl(href));
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    const manual = ['linkedin.com', 'indeed.com', 'glassdoor.com', 'ziprecruiter.com', 'joinhandshake.com'];
    if (manual.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** A generic application form is not a requisition id. Only recognizable job links qualify. */
function repositoryPostingId(link: string): string | undefined {
  const url = new URL(link);
  const jobPath = /\/(?:jobs?|positions?|results|info|search)\//i.test(url.pathname)
    || /^(?:jobs\.lever\.co|jobs\.ashbyhq\.com)$/i.test(url.hostname);
  const hasId = /\d{4,}|[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}|[a-f\d]{24}/i.test(url.pathname);
  const idParameter = [...url.searchParams.keys()].some((key) =>
    /^(?:gh_jid|job_?id|requisition_?id|position_?id|pid)$/i.test(key) && Boolean(url.searchParams.get(key)));
  return (jobPath && hasId) || idParameter ? link : undefined;
}

/** GitHub renders Markdown tables for us; the parser consumes the same HTML cell contract. */
export function parseRepositoryTables(html: string, now: number, source: string): {
  postings: ConnectorPosting[]; invalidRows: number;
} {
  const postings: ConnectorPosting[] = [];
  let invalidRows = 0;
  for (const [, table] of html.matchAll(/<table\b[^>]*>([^]*?)<\/table>/gi)) {
    let columns: Record<'company' | 'title' | 'location' | 'apply' | 'date' | 'salary' | 'mode', number> | null = null;
    let company = '';
    for (const [, row] of table.matchAll(/<tr\b[^>]*>([^]*?)<\/tr>/gi)) {
      const cells = [...row.matchAll(/<(td|th)\b[^>]*>([^]*?)<\/\1>/gi)].map((match) => match[2]);
      if (/<th\b/i.test(row)) {
        const labels = cells.map((cell) => tableText(cell).toLowerCase().replace(/[^a-z]/g, ''));
        const index = (...names: string[]) => labels.findIndex((label) => names.includes(label));
        const next = {
          company: index('company'), title: index('role', 'position', 'jobtitle'),
          location: index('location'), apply: index('applicationlink', 'application', 'posting', 'apply'),
          date: index('dateposted', 'age', 'posted'), salary: index('salary'), mode: index('workmodel', 'workmode'),
        };
        columns = next.company >= 0 && next.title >= 0 && next.date >= 0 ? next : null;
        company = '';
        continue;
      }
      if (!columns || cells.length === 0) continue;
      const cell = (field: keyof NonNullable<typeof columns>) => cells[columns![field]] ?? '';
      const name = tableText(cell('company'));
      if (name !== '\u21b3') company = name;
      const title = tableText(cell('title'));
      const applyCell = columns.apply >= 0 ? cell('apply') : cell('title');
      if (columns.apply >= 0 && /\u{1f512}|^(?:closed|expired|filled|applications? closed)$/iu.test(tableText(applyCell))) continue;
      const sourceUrl = applicationLink(applyCell);
      if (!company || !title || !sourceUrl) { invalidRows += 1; continue; }
      const location = tableText(cell('location'));
      const mode = tableText(cell('mode')).toLowerCase().replace(/[\s-]/g, '');
      const workMode = mode === 'remote' || mode === 'hybrid' || mode === 'onsite' ? mode : undefined;
      const salary = tableText(cell('salary'));
      const description = /\p{Sc}/u.test(salary) && /\d/.test(salary) ? `Salary: ${salary}` : '';
      const publisherId = repositoryPostingId(sourceUrl);
      postings.push({
        source, sourceKind: 'repo', sourceUrl, ...(publisherId ? { publisherId } : {}),
        company, title, location: location || null, postedAt: repositoryDate(tableText(cell('date')), now),
        // Preserve the supplied salary field, not an invented job description.
        description,
        sourceFields: {
          ...(location ? { location } : {}),
          ...(workMode ? { workMode } : {}),
        },
      });
    }
  }
  return { postings, invalidRows };
}

const SPEEDY_FILES = ['README.md', 'NEW_GRAD_USA.md', 'INTERN_INTL.md', 'NEW_GRAD_INTL.md'];
const REPOSITORIES = [
  { name: 'vansh-internships', repo: 'vanshb03/Summer2027-Internships', branch: 'dev', files: ['README.md'] },
  { name: 'speedyapply-ai', repo: 'speedyapply/2027-AI-College-Jobs', branch: 'main', files: SPEEDY_FILES },
  { name: 'speedyapply-swe', repo: 'speedyapply/2027-SWE-College-Jobs', branch: 'main', files: SPEEDY_FILES },
  { name: 'jobright-software', repo: 'jobright-ai/2026-Software-Engineer-Internship', branch: 'master', files: ['README.md'] },
  { name: 'jobright-engineering', repo: 'jobright-ai/2026-Engineer-Internship', branch: 'master', files: ['README.md'] },
  { name: 'jobright-marketing', repo: 'jobright-ai/2026-Marketing-Internship', branch: 'master', files: ['README.md'] },
  { name: 'jobright-design', repo: 'jobright-ai/2026-Design-Internship', branch: 'master', files: ['README.md'] },
  { name: 'jobright-art', repo: 'jobright-ai/2026-Art-Internship', branch: 'master', files: ['README.md'] },
] as const;

export const additionalRepoConnectors: Connector[] = REPOSITORIES.map(({ name, repo, branch, files }) => ({
  name,
  kind: 'repo',
  minIntervalMs: 3 * 60 * 60 * 1000,
  async fetch(context) {
    // A row aging out of a seven-day/120-day list is not evidence that the job closed.
    context.degraded('Curated repository snapshot; absence is not closure evidence');
    const errors: string[] = [];
    const now = Date.now();
    const headers: Record<string, string> = { Accept: 'application/vnd.github.html+json' };
    if (context.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${context.env.GITHUB_TOKEN}`;
    const results = await Promise.all(files.map(async (file) => {
      try {
        const html = await context.runtime.fetchText(
          `https://api.github.com/repos/${repo}/contents/${file}?ref=${branch}`, { headers },
        );
        const parsed = parseRepositoryTables(html, now, name);
        if (parsed.postings.length === 0) throw new Error('No readable job rows');
        if (parsed.invalidRows) context.degraded(`${file}: ${parsed.invalidRows} invalid or manual-only rows skipped`);
        context.log({ connector: name, file, fetched: parsed.postings.length, invalidRows: parsed.invalidRows });
        return parsed.postings;
      } catch (error) {
        const message = redact(error instanceof Error ? error.message : String(error));
        errors.push(`${file}: ${message}`);
        context.degraded(`${file}: ${message}`);
        context.log({ connector: name, file, status: 'error', error: message });
        return [];
      }
    }));
    const postings = results.flat();
    if (postings.length === 0) throw new Error(`${name}: ${errors.join('; ')}`);
    return postings;
  },
}));

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

export const repoConnectors: Connector[] = [simplifyInternships, simplifyNewGrads, ...additionalRepoConnectors];
