/**
 * Normalizers — pure, no I/O, deterministic, idempotent.
 *
 * Every one of these satisfies `f(f(x)) === f(x)`; the property is asserted in
 * `normalize.test.ts` over a generated input set. `dedupe.ts`, `geo.ts` and the enrichment
 * cache key all depend on that, so keep it true when editing.
 */

export interface NormalizedLocation {
  /** Alias key for a recognized metro (`sf` | `la` | `nyc` | `sea`), else a slug, else null. */
  city_norm: string | null;
  /** Two-letter US state code, uppercase. `CA` for ANY recognized California city. */
  state: string | null;
  /** ISO-3166 alpha-2, uppercase. */
  country: string | null;
  is_remote: boolean;
}

/** Whole trailing tokens only — never a substring, or "Cisco" becomes "Cis". */
const LEGAL_SUFFIX = /(?:\s+(?:inc|llc|ltd|corp|co|gmbh|sa))+$/;

/**
 * Metro alias tables, exactly as specced. These are *spelling* normalization, not ranking —
 * geo priority lives in `geo.ts` and nowhere else. `geo.ts` refers to the keys below.
 */
export const CITY_ALIASES = {
  sf: {
    state: 'CA',
    country: 'US',
    aliases: [
      'SF',
      'San Francisco',
      'San Francisco Bay Area',
      'Palo Alto',
      'Mountain View',
      'South Bay',
    ],
  },
  la: {
    state: 'CA',
    country: 'US',
    aliases: ['LA', 'Los Angeles', 'Santa Monica', 'Culver City', 'Pasadena', 'Burbank'],
  },
  nyc: {
    state: 'NY',
    country: 'US',
    aliases: ['NYC', 'New York, NY', 'Manhattan', 'Brooklyn'],
  },
  sea: {
    state: 'WA',
    country: 'US',
    aliases: ['Seattle', 'Bellevue', 'Redmond'],
  },
} as const satisfies Record<string, { state: string; country: string; aliases: readonly string[] }>;

/**
 * California cities outside the named metros. Any hit here sets `state = 'CA'`, which is
 * what puts Sacramento and San Diego in geo tier 1 rather than tier 3. Extend freely.
 */
export const CALIFORNIA_CITIES: readonly string[] = [
  'sacramento',
  'san diego',
  'san jose',
  'oakland',
  'berkeley',
  'fresno',
  'long beach',
  'irvine',
  'santa clara',
  'sunnyvale',
  'cupertino',
  'menlo park',
  'redwood city',
  'san mateo',
  'foster city',
  'emeryville',
  'san bruno',
  'santa barbara',
  'anaheim',
  'riverside',
  'el segundo',
  'playa vista',
  'glendale',
  'walnut creek',
  'fremont',
  'san rafael',
];

/** `ca` resolves to California, not Canada — states are looked up before countries. */
const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA',
  colorado: 'CO', connecticut: 'CT', delaware: 'DE', florida: 'FL', georgia: 'GA',
  hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA', kansas: 'KS',
  kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA',
  michigan: 'MI', minnesota: 'MN', mississippi: 'MS', missouri: 'MO', montana: 'MT',
  nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH',
  oklahoma: 'OK', oregon: 'OR', pennsylvania: 'PA', 'rhode island': 'RI',
  'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV',
  wisconsin: 'WI', wyoming: 'WY', 'washington dc': 'DC', 'district of columbia': 'DC',
};

const COUNTRIES: Record<string, string> = {
  us: 'US', usa: 'US', 'u s a': 'US', 'united states': 'US',
  'united states of america': 'US', america: 'US',
  ca: 'CA', canada: 'CA',
  uk: 'GB', 'united kingdom': 'GB', england: 'GB', scotland: 'GB',
  de: 'DE', germany: 'DE', deutschland: 'DE',
  fr: 'FR', france: 'FR',
  nl: 'NL', netherlands: 'NL',
  ie: 'IE', ireland: 'IE',
  es: 'ES', spain: 'ES',
  pl: 'PL', poland: 'PL',
  in: 'IN', india: 'IN',
  au: 'AU', australia: 'AU',
  jp: 'JP', japan: 'JP',
  sg: 'SG', singapore: 'SG',
};

const REMOTE_MARKERS = [
  'remote',
  'work from home',
  'wfh',
  'anywhere',
  'distributed',
  'telecommute',
];

/**
 * Work-mode words are not places. Without this, "Hybrid - San Francisco, CA" yields
 * `city_norm: 'hybrid'` and never merges with the same job listed as "San Francisco, CA".
 * `work_mode` is a classification field (phase 4); nothing is lost by dropping it here.
 */
const WORK_MODE_MARKERS = ['hybrid', 'on site', 'onsite', 'in office', 'in person', 'flexible'];

// Maps, not object literals: a segment like "constructor" must miss, not inherit a match.
type MetroKey = keyof typeof CITY_ALIASES;

const ALIAS_LOOKUP = new Map<string, MetroKey>();
for (const [key, entry] of Object.entries(CITY_ALIASES)) {
  for (const alias of entry.aliases) {
    // Aliases are stored as specced ("New York, NY"); locations are matched per
    // comma-segment, so register the whole spelling and its leading segment.
    ALIAS_LOOKUP.set(slug(alias), key as MetroKey);
    ALIAS_LOOKUP.set(slug(alias.split(',')[0]), key as MetroKey);
  }
}

const STATE_LOOKUP = new Map(Object.entries(US_STATES));
for (const code of new Set(Object.values(US_STATES))) STATE_LOOKUP.set(code.toLowerCase(), code);

const COUNTRY_LOOKUP = new Map(Object.entries(COUNTRIES));
const CALIFORNIA_SET = new Set(CALIFORNIA_CITIES);

/** lowercase · drop apostrophes · every other non-alphanumeric run becomes one space. */
function slug(input: string): string {
  return input
    .toLowerCase()
    .replace(/['‘’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Lowercase, strip punctuation, collapse whitespace, then drop trailing legal suffixes
 * (`inc llc ltd corp co gmbh sa`) as whole tokens.
 *
 *   "Acme, Inc."      -> "acme"
 *   "Foo Co., Ltd."   -> "foo"
 *   "Cisco"           -> "cisco"          (suffix never matches inside a word)
 *   "Ltd Commodities" -> "ltd commodities" (leading, not trailing)
 *   "Incident.io"     -> "incident io"
 */
export function normalizeCompany(input: string | null | undefined): string {
  const cleaned = slug(input ?? '');
  if (!cleaned) return '';
  return cleaned.replace(LEGAL_SUFFIX, '').trim() || cleaned;
}

/**
 * Req-ID shapes, stripped from titles. A bare four-digit number is left alone: it is far
 * more often an intake year ("Summer 2026") than a requisition, and collapsing the years
 * would merge two intakes into one posting.
 */
const REQ_ID_PATTERNS: RegExp[] = [
  /#\s*\d+/g,
  /\breq(?:uisition)?[\s.:#_-]*(?:id|no|number)?[\s.:#_-]*[a-z]*\d+\b/g,
  /\b[a-z]{1,3}[-_]?\d{4,}\b/g,
  /\b\d{5,}\b/g,
];

const TITLE_SEGMENT = /\s*[,‐-―|@]\s*|\s+-\s+|\s-\s*$/;

/**
 * Lowercase · strip trailing bracketed and parenthesized suffixes · strip req IDs · strip a
 * trailing location · punctuation to spaces · collapse whitespace.
 *
 *   "Senior Product Designer (Remote) [REQ-1042]"     -> "senior product designer"
 *   "Software Engineer, Backend - San Francisco, CA"  -> "software engineer backend"
 *   "Software Engineering Intern - Summer 2026"       -> "software engineering intern summer 2026"
 *
 * ponytail: a trailing parenthesis is always noise here, so "Engineer (Backend)" and
 * "Engineer (Frontend)" collapse to the same title. That is the spec'd behavior; if it ever
 * produces a bad merge, keep the group when its contents are not location/req/mode words.
 */
export function normalizeTitle(input: string | null | undefined): string {
  let title = (input ?? '').toLowerCase().trim();
  if (!title) return '';

  for (let previous = ''; title !== previous; ) {
    previous = title;
    title = title.replace(/[([{][^)\]}]*[)\]}]\s*$/, '').trim();
  }

  for (const pattern of REQ_ID_PATTERNS) title = title.replace(pattern, ' ');

  const segments = title
    .split(TITLE_SEGMENT)
    .map((segment) => segment.trim())
    .filter(Boolean);
  while (segments.length > 1 && isRecognizedLocation(segments[segments.length - 1])) {
    segments.pop();
  }

  return slug(segments.join(' ')).replace(/\s+/g, ' ').trim();
}

/**
 * True only for strings this module actually recognizes as a place or a work mode — never
 * for a slug guess. Work modes count because "Product Designer - Hybrid" and "Product
 * Designer" are one job, and a title suffix is the only place this is asked.
 */
function isRecognizedLocation(input: string): boolean {
  const text = slug(input);
  if (!text) return false;
  if (REMOTE_MARKERS.some((marker) => text.includes(marker))) return true;
  if (WORK_MODE_MARKERS.some((marker) => text.includes(marker))) return true;
  return (
    ALIAS_LOOKUP.has(text) ||
    CALIFORNIA_SET.has(text) ||
    STATE_LOOKUP.has(text) ||
    COUNTRY_LOOKUP.has(text)
  );
}

/**
 * "San Francisco, CA" -> { city_norm: 'sf',   state: 'CA', country: 'US', is_remote: false }
 * "Sacramento"        -> { city_norm: 'sacramento', state: 'CA', country: 'US', ... }
 * "Berlin, Germany"   -> { city_norm: 'berlin', state: null, country: 'DE', ... }
 * "Remote, USA"       -> { city_norm: null,   state: null, country: 'US', is_remote: true }
 *
 * A remote posting always has `city_norm = null` (per spec), even when the string also names
 * a city — the remote-vs-city merge pass in `dedupe.ts` is what reconciles those.
 */
export function normalizeLocation(input: string | null | undefined): NormalizedLocation {
  const text = slug(input ?? '');
  const empty: NormalizedLocation = {
    city_norm: null,
    state: null,
    country: null,
    is_remote: false,
  };
  if (!text) return empty;

  const isRemote = REMOTE_MARKERS.some((marker) => text.includes(marker));
  const result: NormalizedLocation = { ...empty, is_remote: isRemote };

  // Brackets and hyphens separate parts too: "San Francisco (Hybrid)" and Workday's
  // "US-CA-San Francisco" must land on the same place as "San Francisco, CA". A hyphenated
  // city ("Winston-Salem") loses its tail, which is lossy but consistent — `city_norm` is a
  // key, not a display value.
  const segments = (input ?? '')
    // ...but "on-site" is one work-mode word, not the city "on".
    .replace(/\b(on|in)-(?=site|office|person)/gi, '$1 ')
    .split(/[,;/()[\]]|[-–—]/)
    .map((part) => slug(part))
    .filter(Boolean);

  // "City, ST" is the conventional order, so a trailing two-letter state code is
  // authoritative: "Washington, DC" is the District, not Washington state.
  for (let index = segments.length - 1; index > 0; index -= 1) {
    const code = segments[index].length === 2 ? STATE_LOOKUP.get(segments[index]) : undefined;
    if (code) {
      result.state = code;
      result.country = 'US';
      break;
    }
  }

  for (const segment of segments) {
    if (REMOTE_MARKERS.some((marker) => segment.includes(marker))) continue;
    if (WORK_MODE_MARKERS.some((marker) => segment.includes(marker))) continue;

    // A two-letter code following a city is a state code, not a metro alias: "New Orleans,
    // LA" is Louisiana, not Los Angeles. Ambiguous codes resolve to the US state ("de" is
    // Delaware) — a non-US country has to be spelled out.
    if (result.city_norm !== null && segment.length === 2) {
      const code = STATE_LOOKUP.get(segment);
      if (code) {
        result.state ??= code;
        result.country ??= 'US';
        continue;
      }
    }

    const alias = ALIAS_LOOKUP.get(segment);
    if (alias) {
      result.city_norm ??= alias;
      result.state ??= CITY_ALIASES[alias].state;
      result.country ??= CITY_ALIASES[alias].country;
      continue;
    }
    if (CALIFORNIA_SET.has(segment)) {
      result.city_norm ??= segment;
      result.state ??= 'CA';
      result.country ??= 'US';
      continue;
    }
    const state = STATE_LOOKUP.get(segment);
    if (state) {
      if (result.state === null) {
        result.state = state;
        result.country ??= 'US';
      } else if (result.state !== state) {
        // A state *name* next to a different, already-known state code is a city:
        // "Washington, DC" is a city in the District, not the state of Washington.
        result.city_norm ??= segment;
      }
      continue;
    }
    const country = COUNTRY_LOOKUP.get(segment);
    if (country) {
      result.country ??= country;
      continue;
    }
    result.city_norm ??= segment;
  }

  if (isRemote) result.city_norm = null;
  return result;
}

const NAMED_ENTITIES = new Map<string, string>(
  Object.entries({
    amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
    ndash: '–', mdash: '—', hellip: '…', bull: '•', middot: '·',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', trade: '™',
    reg: '®', copy: '©', deg: '°', eacute: 'é',
  }),
);

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? match;
  });
}

/**
 * Strip HTML, decode entities, drop markdown markers, collapse whitespace.
 *
 * This is what makes the enrichment cache hit (finding B): Greenhouse escapes its HTML,
 * Lever returns `descriptionPlain` plus a `lists[]` array, Ashby returns markdown, and
 * aggregators reflow all of it. All three shapes of the same job must land on one string.
 *
 * The decode/strip loop runs to a fixed point because Greenhouse escapes markup *inside*
 * escaped markup; every effective pass strictly shortens the string, so it terminates. The
 * fixed point is also what makes this function idempotent.
 *
 * A "tag" must open with a letter, so decoded prose survives: "5 &lt; x &gt; 3" keeps its
 * comparison and "&lt;3 years experience&gt;" is not swallowed whole.
 */
const HTML_TAG = /<!--[\s\S]*?-->|<\/?[a-z][^<>]*>/gi;

export function normalizeDescription(input: string | null | undefined): string {
  let text = input ?? '';
  if (!text) return '';

  for (let previous = '', pass = 0; text !== previous && pass < 32; pass += 1) {
    previous = text;
    text = decodeEntities(text).replace(HTML_TAG, ' ');
  }

  return text
    .replace(/^[ \t]*(?:[-*+]\s+)+/gm, '')
    .replace(/^[ \t]*(?:#{1,6}\s+)+/gm, '')
    .replace(/\*\*|__/g, '')
    .replace(/\s+/gu, ' ')
    .trim();
}
