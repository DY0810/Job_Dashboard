import type { SourceFields } from '../extract.ts';
import { ScreeningRequirementsSchema, type ScreeningRequirements } from './application-context-protocol.ts';

type OfficialPostingInput = {
  sourceUrl: string; company: string; title: string; country: string | null; location: string | null;
  description: string; sourceFields: SourceFields | null; paid: boolean | null;
};

const unique = (values: string[]) => [...new Set(values.map((value) => value.trim()).filter(Boolean))];
const bodyText = (input: OfficialPostingInput) => {
  const structured = input.sourceFields?.sections?.flatMap((section) => [section.heading, ...section.items]) ?? [];
  return [input.title, input.location ?? '', ...structured, input.description].filter(Boolean).join('\n');
};

const MAJORS: readonly [string, RegExp][] = [
  ['computer science', /\bcomputer\s+science\b|\bcs\b/i],
  ['software engineering', /\bsoftware\s+engineering\b/i],
  ['computer engineering', /\bcomputer\s+engineering\b/i],
  ['electrical engineering', /\belectrical\s+engineering\b/i],
  ['mechanical engineering', /\bmechanical\s+engineering\b/i],
  ['data science', /\bdata\s+science\b/i],
  ['mathematics', /\bmathematics?\b|\bmath\b/i],
  ['statistics', /\bstatistics?\b/i],
  ['design', /\bdesign\b/i],
  ['graphic design', /\bgraphic\s+design\b/i],
  ['industrial design', /\bindustrial\s+design\b/i],
  ['product design', /\bproduct\s+design\b/i],
  ['human-computer interaction', /\bhuman[- ]computer\s+interaction\b|\bhci\b/i],
  ['marketing', /\bmarketing\b/i],
  ['communications', /\bcommunications?\b/i],
  ['business', /\bbusiness\b/i],
  ['finance', /\bfinance\b/i],
  ['accounting', /\baccounting\b/i],
  ['economics', /\beconomics?\b/i],
];

const DEGREE_RULES: readonly [string, RegExp][] = [
  ['associate', /\bassociate(?:'s|s)?\b/i],
  ['bachelor', /\bbachelor(?:'s|s)?\b|\bundergraduate\b|\b4[- ]year\s+degree\b/i],
  ['master', /\bmaster(?:'s|s)?\b|\bgraduate\s+degree\b/i],
  ['doctorate', /\bdoctor(?:ate|al)\b|\bph\.?d\.?\b/i],
];

function parseTerms(text: string) {
  const terms: string[] = [];
  for (const match of text.matchAll(/\b(summer|fall|winter|spring)\s+(20\d{2})\b/gi)) terms.push(`${match[1].toLowerCase()} ${match[2]}`);
  for (const match of text.matchAll(/\b(summer|fall|winter|spring)\s+(?:internship|intern|co-?op|term|semester|program|cohort)\b/gi)) terms.push(match[1].toLowerCase());
  return unique(terms);
}

function parsePay(text: string) {
  const values: { currency: string; amount: number; period: 'hour' | 'year' }[] = [];
  const pattern = /(?:(USD|EUR|GBP)\s*)?([$€£])?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?(?:\s*(?:to|-|–)\s*(?:(USD|EUR|GBP)\s*)?([$€£])?\s*(\d[\d,]*(?:\.\d+)?)\s*(k)?)?\s*(?:\/|per\s+)(hour|hr|year|yr)\b/gi;
  const currency = (code: string | undefined, symbol: string | undefined) =>
    code?.toUpperCase() ?? (symbol === '€' ? 'EUR' : symbol === '£' ? 'GBP' : symbol === '$' ? 'USD' : null);
  for (const match of text.matchAll(pattern)) {
    const firstCurrency = currency(match[1], match[2]);
    const secondCurrency = currency(match[5], match[6]);
    if (!firstCurrency || (secondCurrency && secondCurrency !== firstCurrency)) continue;
    const period = /hour|hr/i.test(match[9]) ? 'hour' : 'year';
    const amount = (raw: string, thousands: string | undefined) => Number(raw.replaceAll(',', '')) * (thousands ? 1000 : 1);
    const first = amount(match[3], match[4]);
    const second = match[7] ? amount(match[7], match[8]) : null;
    for (const value of [first, second].filter((item): item is number => item !== null && Number.isFinite(item))) {
      values.push({ currency: firstCurrency, amount: value, period });
    }
  }
  if (!values.length) return null;
  const first = values[0];
  const matching = values.filter((value) => value.currency === first.currency && value.period === first.period);
  return { currency: first.currency, amount: Math.min(...matching.map((value) => value.amount)), period: first.period };
}

function explicitAuthorization(text: string) {
  return /\b(?:must|required|need(?:s)?|eligible|legally)\b[^.]{0,120}\b(?:work authorization|work authorisation|authorized to work|authorised to work)\b/i.test(text) ||
    /\b(?:without|no|not provide|does not provide|cannot provide|unable to provide)\b[^.]{0,100}\b(?:sponsor(?:ship)?|visa)\b/i.test(text);
}

function excerpts(input: OfficialPostingInput, text: string) {
  const sections = input.sourceFields?.sections?.flatMap((section) => [section.heading, ...section.items]) ?? [];
  const paragraphs = text.split(/\n{2,}/).map((value) => value.trim()).filter(Boolean);
  const chunks: string[] = [];
  for (const paragraph of paragraphs) for (let offset = 0; offset < paragraph.length && chunks.length < 24; offset += 900) {
    chunks.push(paragraph.slice(offset, offset + 900));
  }
  return unique([`${input.company} - ${input.title}`, ...sections, ...chunks]).slice(0, 32);
}

export function parseOfficialRequirements(input: OfficialPostingInput): ScreeningRequirements {
  const description = input.description.trim();
  if (!description) throw new Error('OFFICIAL_DESCRIPTION_REQUIRED');
  const text = bodyText({ ...input, description });
  const degreeLevels = DEGREE_RULES.filter(([, pattern]) => pattern.test(text)).map(([value]) => value);
  const majors = MAJORS.filter(([, pattern]) => pattern.test(text)).map(([value]) => value);
  const paid = /\b(?:unpaid|without pay|no compensation|course credit only)\b/i.test(text) ? false :
    /\b(?:paid|stipend|salary|wage|compensation)\b/i.test(text) || parsePay(text) !== null ? true : input.paid;
  const country = input.country?.toUpperCase();
  return ScreeningRequirementsSchema.parse({
    sourceUrl: input.sourceUrl, officialDescription: description, excerpts: excerpts(input, text),
    countries: country && /^[A-Z]{2}$/.test(country) ? [country] : [],
    degreeLevels: unique(degreeLevels), majors: unique(majors), terms: parseTerms(text),
    authorizationRequired: explicitAuthorization(text), paid, payFloor: parsePay(text),
  });
}
