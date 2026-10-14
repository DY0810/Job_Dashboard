import { z } from 'zod';

/** One person at the employer a candidate could reach out to. Every field Hunter may not know is null. */
export type Recruiter = { name: string | null; title: string | null; email: string | null; linkedin: string | null };
export type RecruiterSearch = { label: string; url: string };
export type Recruiters = {
  /** `no_key`: Hunter is not configured; `unavailable`: it failed or is over quota. Searches show either way. */
  lookup: 'ok' | 'no_key' | 'unavailable';
  domain: string | null;
  people: Recruiter[];
  searches: RecruiterSearch[];
};

// Hosts that carry the posting but are not the employer: ATSes and job boards.
const NOT_EMPLOYER = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|icims\.com|jobvite\.com|smartrecruiters\.com|workable\.com|recruitee\.com|bamboohr\.com|rippling\.com|linkedin\.com|indeed\.com|remotive\.com|oraclecloud\.com|taleo\.net|successfactors\.com)$/;
const RECRUITER = /recruit|talent|university|campus|early career|intern/i;

/** The employer's own domain when the posting lives on its site; null when it sits on an ATS or board. */
export function employerDomain(canonicalUrl: string): string | null {
  try {
    const host = new URL(canonicalUrl).hostname.toLowerCase().replace(/^www\./, '');
    return NOT_EMPLOYER.test(host) ? null : host;
  } catch {
    return null;
  }
}

const people = (keywords: string) =>
  `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}`;

/** LinkedIn people searches that work with no key: who recruits for this company. */
export function linkedinSearches(company: string): RecruiterSearch[] {
  return [
    { label: `Recruiters at ${company}`, url: people(`${company} recruiter`) },
    { label: `Talent acquisition at ${company}`, url: people(`${company} talent acquisition`) },
    { label: `University recruiting at ${company}`, url: people(`${company} university recruiting`) },
  ];
}

/** Hunter returns a full profile URL or a bare handle. */
function linkedinUrl(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v) return null;
  return /^https?:\/\//.test(v) ? v : `https://www.linkedin.com/in/${encodeURIComponent(v)}`;
}

const HunterSchema = z.object({ data: z.object({
  domain: z.string().nullable().optional(),
  emails: z.array(z.object({
    value: z.string().nullable().optional(),
    first_name: z.string().nullable().optional(),
    last_name: z.string().nullable().optional(),
    position: z.string().nullable().optional(),
    linkedin: z.string().nullable().optional(),
  })),
}) });

// ponytail: per-instance memory, so a cold serverless start re-asks Hunter; move to the DB if the quota runs short.
const cache = new Map<string, { at: number; value: Recruiters }>();
const DAY = 86_400_000;

/**
 * Hunter's domain search for the company's HR department, recruiting titles first. The employer
 * domain comes from the posting URL; on an ATS-hosted posting Hunter resolves the company name
 * itself, and the domain it resolved is returned so the viewer can tell a wrong match.
 */
export async function findRecruiters(
  posting: { company: string; canonicalUrl: string },
  options: { key?: string; fetch?: typeof fetch } = {},
): Promise<Recruiters> {
  const searches = linkedinSearches(posting.company);
  const key = options.key?.trim();
  if (!key) return { lookup: 'no_key', domain: null, people: [], searches };

  const domain = employerDomain(posting.canonicalUrl);
  const query = new URLSearchParams({ ...(domain ? { domain } : { company: posting.company }), department: 'hr', type: 'personal', limit: '10' });
  const cacheKey = `${key}:${query}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < DAY) return hit.value;

  try {
    const response = await (options.fetch ?? fetch)(`https://api.hunter.io/v2/domain-search?${query}`, {
      headers: { 'X-API-KEY': key }, redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) return { lookup: 'unavailable', domain, people: [], searches };
    const { data } = HunterSchema.parse(await response.json());
    const found = data.emails
      .map((item) => ({
        name: [item.first_name, item.last_name].filter(Boolean).join(' ') || null,
        title: item.position?.trim() || null,
        email: item.value?.trim().toLowerCase() || null,
        linkedin: linkedinUrl(item.linkedin),
      }))
      .sort((a, b) => Number(RECRUITER.test(b.title ?? '')) - Number(RECRUITER.test(a.title ?? '')));
    const value: Recruiters = { lookup: 'ok', domain: data.domain ?? domain, people: found, searches };
    cache.set(cacheKey, { at: Date.now(), value });
    return value;
  } catch {
    return { lookup: 'unavailable', domain, people: [], searches };
  }
}
