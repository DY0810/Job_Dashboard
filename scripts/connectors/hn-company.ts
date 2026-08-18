/**
 * Company/role extraction from HN "Who is Hiring" comments (plan finding A).
 *
 * HN entries are freeform comment text with no structured company field, and `company` is
 * one of the three dedupe-key components — so a wrong extraction does not merely produce a
 * messy row, it produces a phantom posting that will never merge with the same job's ATS
 * row and blows the "zero cross-source duplicates" criterion.
 *
 * The plan's answer is one cached Haiku call per comment. That layer belongs to another
 * phase, so extraction sits behind `CompanyExtractor` and this phase ships a deliberately
 * conservative heuristic instead:
 *
 *   - it reads ONLY the convention `Company | ... | Role | ... | Location` head line;
 *   - it returns null rather than guessing, and a null entry is DROPPED, never stored with
 *     an invented company;
 *   - every row it does emit is written with `source = 'hn'`, so the whole re-extractable
 *     set is exactly `SELECT * FROM posting_sources WHERE source = 'hn'`.
 *
 * TODO(phase 4 / classification owner): replace `heuristicExtractor` with a Haiku extraction
 * call cached on sha256(comment text), per plan §5 finding A, and re-run over the rows above.
 * The gate for that swap is the plan's: sample 20, hand-verify, >= 18 correct. This heuristic
 * is NOT claimed to meet that bar — it trades recall away to keep precision high enough that
 * what it does emit is safe to dedupe against.
 */

import { normalizeLocation } from '../../lib/normalize.ts';

export interface HnExtraction {
  company: string;
  title: string;
  location: string | null;
}

/** Injectable so the LLM version drops in without touching the connector. */
export type CompanyExtractor = (commentHtml: string) => Promise<HnExtraction | null>;

/** Words that mean the segment is a role, a benefit or a place — never a company name. */
const ROLE_WORDS =
  /\b(engineer|engineering|developer|dev|designer|scientist|researcher|analyst|architect|devops|sre|intern|internship|manager|lead|founding|full[-\s]?stack|frontend|front[-\s]?end|backend|back[-\s]?end|mobile|ios|android|data|ml|ai|infra|infrastructure|security|platform|qa|support|product|marketing|sales|recruiter|technician|technical|writer|hiring|roles?|positions?)\b/i;

const NON_COMPANY =
  /\b(remote|onsite|on[-\s]?site|hybrid|anywhere|full[-\s]?time|part[-\s]?time|contract|freelance|intern(ship)?|visa|equity|salary|usd|eur|gbp|\$\d)/i;

/** The head line is everything before HN's first paragraph break. */
function headLine(commentHtml: string): string {
  return commentHtml.split(/<p>/i)[0] ?? '';
}

function stripMarkup(input: string): string {
  return input
    .replace(/<a\b[^>]*>[^]*?<\/a>/gi, " ") // anchor text on HN is the raw URL — drop it whole
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;|&#47;/g, '/')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCompany(segment: string): string {
  return segment
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/\([^)]*\)/g, ' ') // "(Series B)", "(YC W21)"
    .replace(/\b[\w-]+\.(com|io|ai|co|dev|org|net|app)\b/gi, ' ')
    .replace(/[|,;:–—-]+$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Conservative by construction: everything below is a reason to return null.
 *
 * Precision over recall. A dropped HN entry costs one posting; a wrong company costs a
 * permanent phantom duplicate of a job we already have from its ATS.
 */
export const heuristicExtractor: CompanyExtractor = async (commentHtml) => {
  const segments = stripMarkup(headLine(commentHtml))
    .split('|')
    .map((segment) => segment.trim())
    .filter(Boolean);

  // Fewer than three segments means the poster did not follow the convention at all, and
  // anything we pulled out would be a guess.
  if (segments.length < 3) return null;

  const company = cleanCompany(segments[0]);
  if (!company) return null;
  if (company.length > 60 || company.split(/\s+/).length > 5) return null;
  if (ROLE_WORDS.test(company) || NON_COMPANY.test(company)) return null;
  // A company name is a name, not a sentence.
  if (/[.!?]\s|\bwe\b|\bour\b|\bis\b|\bare\b/i.test(company)) return null;

  const rest = segments.slice(1);
  const title = rest.find((segment) => ROLE_WORDS.test(segment) && segment.length <= 90);
  if (!title) return null;

  // A location segment must be one this repo actually RECOGNIZES — not merely a leftover
  // string, or "Full Time" becomes a city and splits the dedupe key.
  const location =
    rest.find((segment) => {
      if (segment === title) return false;
      const parsed = normalizeLocation(segment);
      return parsed.is_remote || parsed.state !== null || parsed.country !== null;
    }) ?? null;

  return { company, title, location };
};
