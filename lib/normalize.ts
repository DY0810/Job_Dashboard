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
      'SF Bay Area',
      'Bay Area',
      'Silicon Valley',
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
  sg: 'SG', sgp: 'SG', singapore: 'SG',
  il: 'IL', israel: 'IL',
  cn: 'CN', china: 'CN',
  hk: 'HK', 'hong kong': 'HK',
  tw: 'TW', taiwan: 'TW',
  kr: 'KR', 'south korea': 'KR', korea: 'KR',
  mx: 'MX', mexico: 'MX', méxico: 'MX',
  br: 'BR', brazil: 'BR', brasil: 'BR',
  ar: 'AR', argentina: 'AR',
  cl: 'CL', chile: 'CL',
  co: 'CO', colombia: 'CO',
  pe: 'PE', peru: 'PE',
  se: 'SE', sweden: 'SE',
  no: 'NO', norway: 'NO',
  dk: 'DK', denmark: 'DK',
  fi: 'FI', finland: 'FI',
  ch: 'CH', switzerland: 'CH',
  at: 'AT', austria: 'AT',
  be: 'BE', belgium: 'BE',
  pt: 'PT', portugal: 'PT',
  it: 'IT', italy: 'IT',
  gr: 'GR', greece: 'GR',
  cz: 'CZ', 'czech republic': 'CZ', czechia: 'CZ',
  ro: 'RO', romania: 'RO',
  hu: 'HU', hungary: 'HU',
  ua: 'UA', ukraine: 'UA',
  tr: 'TR', turkey: 'TR', türkiye: 'TR',
  ae: 'AE', 'united arab emirates': 'AE',
  za: 'ZA', 'south africa': 'ZA',
  ng: 'NG', nigeria: 'NG',
  ke: 'KE', kenya: 'KE',
  eg: 'EG', egypt: 'EG',
  pk: 'PK', pakistan: 'PK',
  bd: 'BD', bangladesh: 'BD',
  lk: 'LK', 'sri lanka': 'LK',
  my: 'MY', malaysia: 'MY',
  id: 'ID', indonesia: 'ID',
  ph: 'PH', philippines: 'PH',
  th: 'TH', thailand: 'TH',
  vn: 'VN', vietnam: 'VN',
  nz: 'NZ', 'new zealand': 'NZ',
  lu: 'LU', luxembourg: 'LU',
  cr: 'CR', 'costa rica': 'CR',
  uy: 'UY', uruguay: 'UY',
};

/**
 * Cities abroad that job boards write without their country: "London", "Bengaluru",
 * "Amsterdam". Without this they fall through to the give-up branch, land in `city_norm` as a
 * bare slug with `country` still NULL, and the foreign-onsite rule in `query.ts` — which asks
 * whether `country` is a non-US country — cannot see them. That was ~1,000 live rows.
 *
 * Consulted LAST, and only via `??=`, which is what makes it safe: "Dublin, OH", "London, KY"
 * and "Berlin, CT" have already had `country = 'US'` stamped by the trailing-state pass before
 * the loop reaches here, so a US namesake with its state spelled out keeps its state. A bare
 * namesake does not, and cannot: nothing in "Dublin" says Ohio.
 *
 * Only names actually seen in the corpus, so this stays a list of observed spellings rather
 * than a world gazetteer nobody maintains.
 *
 * ponytail: `vancouver` is the one real gamble — Vancouver, WA is a US city of 190k, and a
 * posting that says only "Vancouver" is read as British Columbia. Tech postings skew BC hard
 * enough to be worth it; if a Washington role is ever wrongly hidden, spell the state.
 */
const FOREIGN_CITIES: Record<string, string> = {
  london: 'GB',
  bengaluru: 'IN', bangalore: 'IN', hyderabad: 'IN', mumbai: 'IN', pune: 'IN',
  'new delhi': 'IN', delhi: 'IN', chennai: 'IN', gurgaon: 'IN', gurugram: 'IN', noida: 'IN',
  amsterdam: 'NL', hoofddorp: 'NL', rotterdam: 'NL', utrecht: 'NL',
  berlin: 'DE', munich: 'DE', münchen: 'DE', hamburg: 'DE', cologne: 'DE', köln: 'DE',
  frankfurt: 'DE', stuttgart: 'DE',
  toronto: 'CA', vancouver: 'CA', montreal: 'CA', montréal: 'CA', ottawa: 'CA',
  calgary: 'CA', waterloo: 'CA', mississauga: 'CA',
  dublin: 'IE', cork: 'IE',
  shanghai: 'CN', beijing: 'CN', guangzhou: 'CN', shenzhen: 'CN', hangzhou: 'CN',
  tokyo: 'JP', osaka: 'JP', kyoto: 'JP',
  'mexico city': 'MX', 'cidade do méxico': 'MX', guadalajara: 'MX', monterrey: 'MX',
  'são paulo': 'BR', 'sao paulo': 'BR', 'rio de janeiro': 'BR', 'belo horizonte': 'BR',
  sydney: 'AU', melbourne: 'AU', brisbane: 'AU', perth: 'AU',
  seoul: 'KR',
  helsinki: 'FI',
  stockholm: 'SE', gothenburg: 'SE',
  oslo: 'NO',
  copenhagen: 'DK', københavn: 'DK',
  warsaw: 'PL', warszawa: 'PL', krakow: 'PL', kraków: 'PL', wroclaw: 'PL', wrocław: 'PL',
  dubai: 'AE', 'abu dhabi': 'AE',
  bogotá: 'CO', bogota: 'CO', medellin: 'CO', medellín: 'CO',
  madrid: 'ES', barcelona: 'ES', valencia: 'ES',
  budapest: 'HU',
  'taipei city': 'TW', taipei: 'TW',
  'tel aviv': 'IL', 'tel aviv yafo': 'IL', jerusalem: 'IL', herzliya: 'IL',
  paris: 'FR', lyon: 'FR', toulouse: 'FR',
  zurich: 'CH', zürich: 'CH', geneva: 'CH', lausanne: 'CH',
  vienna: 'AT', wien: 'AT',
  brussels: 'BE', antwerp: 'BE',
  lisbon: 'PT', lisboa: 'PT', porto: 'PT',
  milan: 'IT', milano: 'IT', rome: 'IT', roma: 'IT',
  athens: 'GR',
  prague: 'CZ', praha: 'CZ', brno: 'CZ',
  bucharest: 'RO', bucuresti: 'RO', cluj: 'RO',
  kyiv: 'UA', kiev: 'UA', lviv: 'UA',
  istanbul: 'TR', ankara: 'TR',
  'cape town': 'ZA', johannesburg: 'ZA',
  lagos: 'NG',
  nairobi: 'KE',
  cairo: 'EG',
  karachi: 'PK', lahore: 'PK',
  dhaka: 'BD',
  colombo: 'LK',
  'kuala lumpur': 'MY',
  jakarta: 'ID',
  manila: 'PH', 'quezon city': 'PH', cebu: 'PH',
  bangkok: 'TH',
  hanoi: 'VN', 'ho chi minh city': 'VN',
  auckland: 'NZ', wellington: 'NZ',
  'buenos aires': 'AR',
  santiago: 'CL',
  lima: 'PE',
  'san jose costa rica': 'CR',
  montevideo: 'UY',
  edinburgh: 'GB', glasgow: 'GB', bristol: 'GB', leeds: 'GB', cambridgeshire: 'GB',
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

/**
 * Facility nouns a job board hangs off a city name: "New York City", "New York HQ",
 * "San Francisco Office", "Los Angeles Metro Area". 137 postings in the live corpus carry one
 * of these and resolved to a raw slug instead of their metro, which cost them their alias in
 * `city_norm` — and `city_norm` is a `dedupe_key` component, so the same job posted as
 * "New York, NY" on an ATS and "New York City, …" on an aggregator would not merge.
 *
 * Stripped as whole trailing tokens, never by prefix: "New York Mills, MN" keeps its own
 * identity, because `mills` is not one of these.
 */
const FACILITY_TAIL = /\s+(?:office|offices|hq|headquarters|campus|city|metro|area|region)$/;

/**
 * Boards that hang several sites off one posting write the GROUP's name into the location
 * field, and the group's name is not a place. Three dialects, 635 live rows:
 *
 *   Greenhouse (Stripe)   "Ireland Locations", "India Locations", "United Arab Emirates Locations"
 *   Workday               "2 Locations", "117 Locations"
 *   simplify-internships  "5 locations waukegan", "9 locations palo alto"
 *
 * The count is noise and `locations` is a common noun, but what sits beside them is real — a
 * country in the first dialect, a city in the third. Stripping only those two shapes turns
 * "Ireland Locations" into Ireland and "9 locations palo alto" into Palo Alto, while "2
 * Locations" correctly becomes nothing at all: a count of sites says nothing about where they
 * are, and a row with no location is honest missing data. Storing "2 locations" as a *city* was
 * not — `city_norm` is a `dedupe_key` component, so it made a count into a place identity and
 * kept the same job at two real sites from ever merging.
 *
 * Deliberately not folded into `FACILITY_TAIL`: that list is consulted for city lookups only,
 * and these have to be gone before the country lookup ever sees the segment.
 */
const LOCATION_GROUP = /\b\d+\s+locations?\b|\blocations?\b(?=\s*$)/gi;

/** The other half of the same habit: "Greater Seattle Area", "Greater New York City Area". */
const LEADING_MODIFIER = /^greater\s+/;

/**
 * Spellings of a segment to try against the *city* tables, longest first. Both affixes are
 * stripped and every intermediate form is offered, so "Greater New York City Area" reaches
 * "new york" through "new york city".
 *
 * City tables only, and that restriction is the whole point of returning a list instead of
 * stripping up front: `STATE_LOOKUP` must never see a stripped form, or "Kansas City, MO"
 * becomes the state of Kansas. An unrecognized segment keeps its original spelling, which is
 * what leaves "Salt Lake City" and "New York Mills" alone.
 */
function citySpellings(segment: string): string[] {
  const spellings = [segment];
  for (let text = segment; ; ) {
    const stripped = text.replace(FACILITY_TAIL, '').replace(LEADING_MODIFIER, '');
    if (stripped === text) return spellings;
    spellings.push(stripped);
    text = stripped;
  }
}

const STATE_LOOKUP = new Map(Object.entries(US_STATES));
for (const code of new Set(Object.values(US_STATES))) STATE_LOOKUP.set(code.toLowerCase(), code);

const COUNTRY_LOOKUP = new Map(Object.entries(COUNTRIES));
const FOREIGN_CITY_LOOKUP = new Map(Object.entries(FOREIGN_CITIES));
const CALIFORNIA_SET = new Set(CALIFORNIA_CITIES);

/**
 * A city is disambiguated by the state written *next to it* and by nothing else. "Manhattan,
 * KS" is not New York and "Pasadena, TX" is not Los Angeles; but
 * "New York, New York, United States, San Francisco, CA | New York City, NY | Seattle, WA"
 * genuinely is New York, and its trailing WA belongs to Seattle. Comparing a city against the
 * record's accumulated state instead of its own neighbour reads that string as a
 * contradiction and strips metro status from ~281 real multi-location postings.
 */
function contradicts(next: string | undefined, state: string): boolean {
  const adjacent = next === undefined ? undefined : STATE_LOOKUP.get(next);
  return adjacent !== undefined && adjacent !== state;
}

interface CityHit {
  city: string;
  state: string;
  country: string;
}

/** Metro alias or named California city, with the facility tolerance and the guard applied. */
function resolveCity(segment: string, next: string | undefined): CityHit | undefined {
  for (const spelling of citySpellings(segment)) {
    const alias: MetroKey | undefined = ALIAS_LOOKUP.get(spelling);
    if (alias) {
      const entry = CITY_ALIASES[alias];
      if (contradicts(next, entry.state)) return undefined;
      return { city: alias, state: entry.state, country: entry.country };
    }
    if (CALIFORNIA_SET.has(spelling)) {
      if (contradicts(next, 'CA')) return undefined;
      return { city: spelling, state: 'CA', country: 'US' };
    }
  }
  return undefined;
}

/**
 * Whole tokens. `segment.includes('in office')` also matched inside "berl-in office", which
 * discarded the only segment of "Berlin Office" and left the posting with no location at all
 * — tier `unknown`, which the Design tab shows. Segments are slugs, so padding with spaces is
 * a word-boundary search.
 */
function hasWorkMode(segment: string): boolean {
  const padded = ` ${segment} `;
  return WORK_MODE_MARKERS.some((marker) => padded.includes(` ${marker} `));
}

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
 * Eligibility qualifiers, which name no place: the remote boards state a restriction as
 * "United States only", "US only", "Europe only". Without this the whole string misses every
 * lookup and lands in `city_norm` as the junk key `united states only` — country null, state
 * null — which on the Design tab means an American posting classified as elsewhere and hidden.
 *
 * Applied to location strings only, never through `slug` itself, which also normalizes company
 * and title text where a trailing "Only" could be part of a real name.
 */
const QUALIFIER = /\s+only$/;

function placeSlug(input: string): string {
  return slug(input).replace(QUALIFIER, '').trim();
}

/**
 * True only for strings this module actually recognizes as a place or a work mode — never
 * for a slug guess. Work modes count because "Product Designer - Hybrid" and "Product
 * Designer" are one job, and a title suffix is the only place this is asked.
 */
function isRecognizedLocation(input: string): boolean {
  const text = placeSlug(input);
  if (!text) return false;
  if (REMOTE_MARKERS.some((marker) => text.includes(marker))) return true;
  if (hasWorkMode(text)) return true;
  return (
    // Same tolerance as `normalizeLocation`, for the same reason: aggregators append the
    // location to the title, and "… - New York City" has to strip like "… - New York, NY".
    citySpellings(text).some((spelling) => ALIAS_LOOKUP.has(spelling) || CALIFORNIA_SET.has(spelling)) ||
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
  // Before anything else, because a group name has to be gone by the time the country lookup
  // runs — "Ireland Locations" only reads as Ireland once the noun is off it.
  const cleaned = (input ?? '').replace(LOCATION_GROUP, ' ');
  const text = placeSlug(cleaned);
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
  const segments = cleaned
    // ...but "on-site" is one work-mode word, not the city "on".
    .replace(/\b(on|in)-(?=site|office|person)/gi, '$1 ')
    .split(/[,;/()[\]]|[-–—]/)
    .map((part) => placeSlug(part))
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

  /**
   * Whether `city_norm` came from a table or from giving up. A posting listed in several
   * places writes the ATS's own city first and the board's list after — "Washington, District
   * of Columbia, United States, San Francisco, CA; St. Louis, MO; New York, NY" — so taking
   * the first segment that stuck reads a job listed in SF, NYC and DC as Washington, and the
   * Design tab drops it. A recognized city displaces a slug the parser merely gave up on;
   * among recognized cities the first still wins.
   */
  let recognized = false;

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (REMOTE_MARKERS.some((marker) => segment.includes(marker))) continue;
    if (hasWorkMode(segment)) continue;

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

    const city = resolveCity(segment, segments[index + 1]);
    if (city) {
      if (!recognized) {
        result.city_norm = city.city;
        recognized = true;
      }
      result.state ??= city.state;
      result.country ??= city.country;
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
    // A city abroad that arrived without its country. `??=` on both fields: a US state already
    // read from this string wins, and a recognized metro earlier in it keeps `city_norm`.
    const abroad = FOREIGN_CITY_LOOKUP.get(segment);
    if (abroad) {
      result.country ??= abroad;
      result.city_norm ??= segment;
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
 * Entity decoding on its own, run to a fixed point.
 *
 * `normalizeDescription` throws the markup away, which is right for the stored body and
 * wrong for `parseSections` in `lib/extract.ts` — list structure only exists in the markup.
 * Greenhouse escapes markup *inside* escaped markup, so one pass leaves `&lt;li&gt;` where a
 * list item should be; every effective pass strictly shortens the string, so this terminates.
 */
export function decodeHtmlEntities(input: string | null | undefined): string {
  let text = input ?? '';
  for (let previous = '', pass = 0; text !== previous && pass < 8; pass += 1) {
    previous = text;
    text = decodeEntities(text);
  }
  return text;
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
