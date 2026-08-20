import { describe, expect, it } from 'vitest';

import { GEO_TIER, geoTier } from './geo.ts';
import {
  CALIFORNIA_CITIES,
  CITY_ALIASES,
  normalizeCompany,
  normalizeDescription,
  normalizeLocation,
  normalizeTitle,
} from './normalize.ts';

describe('normalizeCompany', () => {
  // GATE: suffix-strip safety. A suffix is only stripped as a whole trailing token.
  it.each([
    ['Cisco', 'cisco'],
    ['Coinbase', 'coinbase'],
    ['Incident.io', 'incident io'],
    ['Ltd Commodities', 'ltd commodities'],
  ])('leaves %s intact', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });

  it.each([
    ['Acme, Inc.', 'acme'],
    ['Vercel Inc', 'vercel'],
    ['Foo Co., Ltd.', 'foo'],
    ['Bosch GmbH', 'bosch'],
    ['Nestle SA', 'nestle'],
    ['Basecamp LLC', 'basecamp'],
    ['Anthropic PBC', 'anthropic pbc'], // PBC is not in the suffix list
  ])('strips trailing legal suffixes: %s', (input, expected) => {
    expect(normalizeCompany(input)).toBe(expected);
  });

  it('strips punctuation and collapses whitespace', () => {
    expect(normalizeCompany("  Ben & Jerry's  ")).toBe('ben jerrys');
    expect(normalizeCompany('Stripe   Payments')).toBe('stripe payments');
    expect(normalizeCompany('37signals')).toBe('37signals');
  });

  it('never strips a company down to nothing', () => {
    expect(normalizeCompany('Inc')).toBe('inc');
    expect(normalizeCompany('Co.')).toBe('co');
  });

  it('is total over junk input', () => {
    expect(normalizeCompany(null)).toBe('');
    expect(normalizeCompany(undefined)).toBe('');
    expect(normalizeCompany('   ')).toBe('');
  });
});

describe('normalizeTitle', () => {
  it.each([
    ['Senior Product Designer (Remote) [REQ-1042]', 'senior product designer'],
    ['Product Designer II (Req #12345)', 'product designer ii'],
    ['Software Engineer, Backend - San Francisco, CA', 'software engineer backend'],
    ['Frontend Engineer — Remote', 'frontend engineer'],
    ['UI/UX Designer', 'ui ux designer'],
    ['Staff Engineer #45210', 'staff engineer'],
    ['Data Analyst JR-102938', 'data analyst'],
    ['Product Designer @ New York, NY', 'product designer'],
    ['Product Designer - Hybrid', 'product designer'],
  ])('normalizes %s', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });

  it('keeps level markers and years that are not req IDs', () => {
    expect(normalizeTitle('Engineer III')).toBe('engineer iii');
    expect(normalizeTitle('Product Designer 2')).toBe('product designer 2');
    // A year is never a req ID — internship years must survive or two intake years merge.
    expect(normalizeTitle('Software Engineering Intern - Summer 2026')).toBe(
      'software engineering intern summer 2026',
    );
  });

  it('is total over junk input', () => {
    expect(normalizeTitle(null)).toBe('');
    expect(normalizeTitle('  ')).toBe('');
  });
});

describe('normalizeLocation', () => {
  /**
   * The remote boards state a restriction rather than a place: "United States only", "US only".
   * Without the qualifier strip the whole string misses every lookup and lands in `city_norm`
   * as the junk key `united states only` with country null — which on the Design tab reads as
   * elsewhere, so an American posting is hidden by the location rule.
   */
  it.each([
    ['United States only', 'US'],
    ['US only', 'US'],
    ['USA only', 'US'],
    ['United States', 'US'],
    ['Canada only', 'CA'],
  ])('reads %s as an eligibility qualifier, not a place name', (input, country) => {
    const result = normalizeLocation(input);
    expect(result.country).toBe(country);
    expect(result.city_norm).toBeNull();
  });

  /** Only a TRAILING qualifier is noise — a leading "Only" can be part of a real name. */
  it('leaves a name that merely starts with Only alone', () => {
    expect(normalizeLocation('Only Connect Studios').city_norm).toBe('only connect studios');
  });

  /**
   * Job boards hang a facility noun off the city: "New York City", "New York HQ", "San
   * Francisco Office". These resolve to the metro's alias key rather than to a raw slug,
   * because `city_norm` feeds both `dedupe_key` and the Design tab's location rule — a miss
   * costs a merge in one and the whole posting in the other.
   */
  it.each([
    ['New York City, New York, United States', 'nyc'],
    ['New York HQ', 'nyc'],
    ['New York Office', 'nyc'],
    ['San Francisco Office', 'sf'],
    ['Los Angeles Metro Area', 'la'],
    ['Seattle Campus', 'sea'],
  ])('resolves the board spelling %s to %s', (input, expected) => {
    expect(normalizeLocation(input).city_norm).toBe(expected);
  });

  /** Whole trailing tokens only, never a prefix — otherwise a Minnesota town of 1,200 people
   *  becomes a target metro, which set membership could never have got wrong. */
  it.each([
    ['New York Mills, MN', 'new york mills'],
    ['Kansas City, MO', 'kansas city'],
    ['Salt Lake City, UT', 'salt lake city'],
  ])('does not let %s reach a metro alias', (input, expected) => {
    expect(normalizeLocation(input).city_norm).toBe(expected);
  });

  it.each([
    ['SF', 'sf'],
    ['San Francisco', 'sf'],
    ['San Francisco Bay Area', 'sf'],
    ['Palo Alto', 'sf'],
    ['Mountain View', 'sf'],
    ['South Bay', 'sf'],
    ['LA', 'la'],
    ['Los Angeles', 'la'],
    ['Santa Monica', 'la'],
    ['Culver City', 'la'],
    ['Pasadena', 'la'],
    ['Burbank', 'la'],
    ['NYC', 'nyc'],
    ['New York, NY', 'nyc'],
    ['Manhattan', 'nyc'],
    ['Brooklyn', 'nyc'],
    ['Seattle', 'sea'],
    ['Bellevue', 'sea'],
    ['Redmond', 'sea'],
  ])('maps %s to the %s alias', (input, expected) => {
    expect(normalizeLocation(input).city_norm).toBe(expected);
  });

  it('sets state CA for any recognized California city, not only the metros', () => {
    expect(normalizeLocation('Sacramento')).toEqual({
      city_norm: 'sacramento',
      state: 'CA',
      country: 'US',
      is_remote: false,
    });
    expect(normalizeLocation('San Diego, CA')).toEqual({
      city_norm: 'san diego',
      state: 'CA',
      country: 'US',
      is_remote: false,
    });
    expect(normalizeLocation('Palo Alto').state).toBe('CA');
    expect(normalizeLocation('Los Angeles').state).toBe('CA');
  });

  it('resolves state and country for non-California US metros', () => {
    expect(normalizeLocation('New York, NY')).toEqual({
      city_norm: 'nyc',
      state: 'NY',
      country: 'US',
      is_remote: false,
    });
    expect(normalizeLocation('Seattle').state).toBe('WA');
    expect(normalizeLocation('Austin, TX')).toEqual({
      city_norm: 'austin',
      state: 'TX',
      country: 'US',
      is_remote: false,
    });
  });

  it('does not mistake a work mode for a city', () => {
    const sf = normalizeLocation('San Francisco, CA');
    expect(normalizeLocation('Hybrid - San Francisco, CA')).toEqual(sf);
    expect(normalizeLocation('San Francisco (Hybrid)')).toEqual(sf);
    expect(normalizeLocation('On-site — San Francisco, CA')).toEqual(sf);
  });

  it('parses the Workday "US-CA-San Francisco" shape', () => {
    expect(normalizeLocation('US-CA-San Francisco')).toEqual(normalizeLocation('San Francisco, CA'));
  });

  it('lets a trailing state code win over a same-named state', () => {
    expect(normalizeLocation('Washington, DC')).toEqual({
      city_norm: 'washington',
      state: 'DC',
      country: 'US',
      is_remote: false,
    });
  });

  it('reads a two-letter code after a city as a state, not a metro alias', () => {
    expect(normalizeLocation('New Orleans, LA')).toEqual({
      city_norm: 'new orleans',
      state: 'LA',
      country: 'US',
      is_remote: false,
    });
    // ...but "LA" on its own is still Los Angeles.
    expect(normalizeLocation('LA').city_norm).toBe('la');
  });

  it.each(['Remote', 'REMOTE', 'Work from home', 'Anywhere in the World', 'Distributed'])(
    'treats %s as remote with a null city',
    (input) => {
      const loc = normalizeLocation(input);
      expect(loc.is_remote).toBe(true);
      expect(loc.city_norm).toBeNull();
    },
  );

  it('reads country from explicit country tokens', () => {
    expect(normalizeLocation('Berlin, Germany')).toEqual({
      city_norm: 'berlin',
      state: null,
      country: 'DE',
      is_remote: false,
    });
    expect(normalizeLocation('Remote, USA')).toEqual({
      city_norm: null,
      state: null,
      country: 'US',
      is_remote: true,
    });
  });

  it('is total over junk input', () => {
    const empty = { city_norm: null, state: null, country: null, is_remote: false };
    expect(normalizeLocation(null)).toEqual(empty);
    expect(normalizeLocation('')).toEqual(empty);
    expect(normalizeLocation('   ')).toEqual(empty);
  });
});

/**
 * GEO_TIER is a visibility gate on the Design tab, not a sort key: `elsewhere` deletes the
 * row. Every case below is a spelling the shipped normalizer got wrong, and the strings are
 * taken from the live corpus wherever the corpus has one — the synthetic fixtures above are
 * exactly why these shipped green.
 */
describe('normalizeLocation as a visibility gate', () => {
  const tierOf = (input: string) => geoTier(normalizeLocation(input));

  /**
   * `'berl-in office'` contains `'in office'`. The substring test discarded the only segment
   * of "Berlin Office", so every field came back null, `geoTier` said `unknown` — a tier the
   * Design tab deliberately shows — and a Berlin role rendered on a tab whose whole rule is
   * that it does not show Berlin.
   */
  it.each(['Berlin Office', 'Austin Office', 'Dublin Office', 'Turin Office'])(
    'does not read a work mode out of the middle of a word: %s',
    (input) => {
      expect(tierOf(input)).toBe(GEO_TIER.elsewhere);
    },
  );

  it('still reads a work mode that really is one', () => {
    const sf = normalizeLocation('San Francisco, CA');
    expect(normalizeLocation('Hybrid - San Francisco, CA')).toEqual(sf);
    // Real corpus spellings — a work-mode word can share a segment with other words.
    expect(normalizeLocation('San Francisco, CA (onsite)')).toEqual(sf);
    expect(normalizeLocation('NYC, on-site').city_norm).toBe('nyc');
    expect(normalizeLocation('Sydney, Australia (Bankstown), hybrid').country).toBe('AU');
  });

  /**
   * The facility tolerance was wired into the metro lookup only, so every California city
   * outside the four metros lost its `CA` and with it its place on the tab. It also split
   * `dedupe_key`: `onsite|oakland office||` against `onsite|oakland|CA|US`.
   */
  it.each([
    ['Oakland Office', 'oakland'],
    ['San Diego Office', 'san diego'],
    ['Berkeley HQ', 'berkeley'],
    ['San Jose Office', 'san jose'],
    ['Sacramento HQ', 'sacramento'],
  ])('gives %s the same city_norm and tier as the bare city', (input, city) => {
    expect(normalizeLocation(input)).toEqual(normalizeLocation(city));
    expect(tierOf(input)).toBe(GEO_TIER.california);
  });

  /** A modifier in front is the same habit as a facility noun behind. */
  it.each([
    ['Greater Seattle Area', 'sea'],
    ['Greater New York City Area', 'nyc'],
    ['Greater Los Angeles Area', 'la'],
    ['SF Bay Area', 'sf'],
    ['Bay Area', 'sf'],
    ['Silicon Valley', 'sf'],
  ])('resolves the aggregator spelling %s to %s', (input, expected) => {
    expect(normalizeLocation(input).city_norm).toBe(expected);
    expect(tierOf(input)).toBe(GEO_TIER.metro);
  });

  /**
   * A city is disambiguated by the state written next to it. "Brooklyn, OH" is two live
   * postings that rendered on the Design tab as New York.
   */
  it.each([
    ['Manhattan, KS', 'manhattan', 'KS'],
    ['Brooklyn, OH', 'brooklyn', 'OH'],
    ['Pasadena, TX', 'pasadena', 'TX'],
    ['Bellevue, NE', 'bellevue', 'NE'],
    ['Redmond, OR', 'redmond', 'OR'],
  ])('%s is not the metro of the same name', (input, city, state) => {
    expect(normalizeLocation(input)).toEqual({
      city_norm: city,
      state,
      country: 'US',
      is_remote: false,
    });
    expect(tierOf(input)).toBe(GEO_TIER.elsewhere);
  });

  it('does not let a state name masquerading as a metro alias survive either', () => {
    // "LA" is Los Angeles on its own, and Louisiana when Louisiana is written next to it.
    expect(normalizeLocation('LA').city_norm).toBe('la');
    expect(normalizeLocation('LA, Louisiana')).toEqual({
      city_norm: null,
      state: 'LA',
      country: 'US',
      is_remote: false,
    });
  });

  it.each(['Manhattan', 'Brooklyn', 'Pasadena', 'Bellevue', 'Redmond'])(
    'leaves %s alone when no state contradicts it',
    (input) => {
      expect(tierOf(input)).toBe(GEO_TIER.metro);
    },
  );

  /**
   * THE TRAP. These are verbatim corpus strings: one posting listed in several places, the
   * ATS city first and the board's own list after. 257 live postings look like this, and
   * almost all of them are Anthropic and Scale AI design roles. Guarding the alias on the
   * record's accumulated state — rather than on the city's own neighbour — reads the
   * trailing "Seattle, WA" as a contradiction of the leading "New York" and sends the whole
   * cohort to `elsewhere`. Nothing in the synthetic fixtures above has this shape.
   */
  it.each([
    'San Francisco, California, United States, San Francisco, CA | New York City, NY',
    'San Francisco, California, United States, San Francisco, CA | New York City, NY | Seattle, WA',
    'New York, New York, United States, San Francisco, CA | New York City, NY | Seattle, WA',
    'San Francisco, California, United States, San Francisco, CA; New York, NY',
    'New York, New York, United States, New York, NY; San Francisco, CA',
    'New York, New York, United States, New York, NY; San Francisco, CA; Seattle, WA; Washington, DC',
    'New York, New York, United States, New York Office',
  ])('keeps metro status for the multi-location posting %#', (input) => {
    expect(GEO_TIER.metros).toContain(normalizeLocation(input).city_norm);
    expect(tierOf(input)).toBe(GEO_TIER.metro);
  });

  /** Same shape, but the board also called the whole thing remote — a target tier of its own. */
  it('keeps a multi-location remote posting visible', () => {
    const input =
      'Remote-Friendly US (Travel Required), Remote-Friendly (Travel-Required) | San Francisco, CA | Seattle, WA | New York City, NY';
    expect(normalizeLocation(input).is_remote).toBe(true);
    expect(tierOf(input)).toBe(GEO_TIER.remote);
  });

  /** Whole trailing tokens only, still — the tolerance must not reach a state name. */
  it.each([
    ['Kansas City, MO', 'kansas city'],
    ['Salt Lake City, UT', 'salt lake city'],
    ['New York Mills, MN', 'new york mills'],
    ['Brooklyn Center, MN', 'brooklyn center'],
    ['Brooklyn Park, MN', 'brooklyn park'],
    ['Berkeley, MO', 'berkeley'],
  ])('does not let %s reach a city table', (input, expected) => {
    expect(normalizeLocation(input).city_norm).toBe(expected);
    expect(tierOf(input)).toBe(GEO_TIER.elsewhere);
  });

  /** Plain foreign and out-of-target cities are unmoved by any of the above. */
  it.each(['Berlin', 'Berlin, Germany', 'London, United Kingdom', 'Austin, TX', 'Toronto, Canada'])(
    '%s still does not show',
    (input) => {
      expect(tierOf(input)).toBe(GEO_TIER.elsewhere);
    },
  );

  it.each(['Oakland', 'Seattle', 'San Francisco, California, United States', 'NYC'])(
    '%s still shows',
    (input) => {
      expect(tierOf(input)).not.toBe(GEO_TIER.elsewhere);
    },
  );
});

/**
 * Aggregators append the location to the title, so the same job arrives as
 * "… - New York City" from one source and "… - New York, NY" from another. `title_norm` is a
 * `dedupe_key` component, so a spelling the title stripper does not recognize is a duplicate
 * posting — the thing dedupe exists to prevent.
 */
describe('normalizeTitle strips the same location spellings', () => {
  it.each([
    'Product Designer - New York, NY',
    'Product Designer - New York City',
    'Product Designer - Greater Seattle Area',
    'Product Designer - San Francisco Office',
    'Product Designer - Bay Area',
    'Product Designer - Oakland HQ',
  ])('%s normalizes to the bare title', (input) => {
    expect(normalizeTitle(input)).toBe('product designer');
  });

  /**
   * The other half of the substring bug: "Hybridisation" contains "hybrid", and one live
   * posting had its subject matter deleted out of its title because of it.
   */
  it('does not strip a real word that merely contains a work mode', () => {
    expect(normalizeTitle('Sr Product Manager - Hybridisation')).toBe(
      'sr product manager hybridisation',
    );
  });

  /** Unchanged: a place the module does not recognize is not a place. */
  it.each([
    ['Engineer - Kansas City', 'engineer kansas city'],
    ['Engineer - Salt Lake City', 'engineer salt lake city'],
  ])('%s keeps its tail', (input, expected) => {
    expect(normalizeTitle(input)).toBe(expected);
  });
});

describe('normalizeDescription', () => {
  it('strips tags, decodes entities, collapses whitespace', () => {
    expect(normalizeDescription('<p>Hello&nbsp;&amp; welcome</p>')).toBe('Hello & welcome');
  });

  it('decodes escaped markup before stripping it (the Greenhouse shape)', () => {
    expect(normalizeDescription('&lt;p&gt;Hello &amp;amp; welcome&lt;/p&gt;')).toBe(
      'Hello & welcome',
    );
  });

  it('strips markdown list and heading markers (the Ashby shape)', () => {
    expect(normalizeDescription('## Responsibilities\n\n- Ship it\n- Then ship again')).toBe(
      'Responsibilities Ship it Then ship again',
    );
  });

  it('keeps prose that merely looks like markup', () => {
    expect(normalizeDescription('<p>Ship when 5 &lt; x &gt; 3 holds</p>')).toBe(
      'Ship when 5 < x > 3 holds',
    );
    expect(normalizeDescription('&lt;3 years experience&gt; preferred')).toBe(
      '<3 years experience> preferred',
    );
  });

  it('drops HTML comments', () => {
    expect(normalizeDescription('<p>Real<!-- tracking pixel -->text</p>')).toBe('Real text');
  });

  it('is total over junk input', () => {
    expect(normalizeDescription(null)).toBe('');
    expect(normalizeDescription('   \n\t ')).toBe('');
  });
});

// FINDING B — the three ATS description shapes must normalize to ONE string. The enrichment
// cache that first motivated this is gone (extraction is free), but the property still
// matters: `lib/extract.ts` reads this text, and three spellings of one job must extract the
// same way whichever source won the merge.
describe('normalizeDescription across the ATS shapes', () => {
  const greenhouseEscapedHtml =
    '&lt;p&gt;We are looking for a Product Designer.&lt;/p&gt;&lt;h3&gt;Responsibilities&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Ship design systems&lt;/li&gt;&lt;li&gt;Partner with engineering&lt;/li&gt;&lt;/ul&gt;';

  const reformattedHtml = [
    '<p>',
    '   We are looking for a Product Designer.',
    '</p>',
    '',
    '<h3>Responsibilities</h3>',
    '<ul>',
    '  <li>Ship design systems</li>',
    '  <li>Partner with engineering</li>',
    '</ul>',
  ].join('\n');

  // Lever: descriptionPlain plus a separate lists[] array, joined by the connector.
  const leverPlain = 'We are looking for a Product Designer.';
  const leverLists = [
    {
      text: 'Responsibilities',
      content: '<li>Ship design systems</li><li>Partner with engineering</li>',
    },
  ];
  const leverJoined = [leverPlain, ...leverLists.map((l) => `${l.text}\n${l.content}`)].join('\n\n');

  // Ashby: markdown.
  const ashbyMarkdown = [
    'We are looking for a Product Designer.',
    '',
    '## Responsibilities',
    '',
    '- Ship design systems',
    '- Partner with engineering',
  ].join('\n');

  it('strips the markup and keeps the prose', () => {
    expect(normalizeDescription(reformattedHtml)).toContain('Product Designer');
  });

  it('lands on one string when HTML and whitespace are reformatted', () => {
    expect(normalizeDescription(greenhouseEscapedHtml)).toBe(normalizeDescription(reformattedHtml));
  });

  it('lands on one string across the Greenhouse, Lever and Ashby shapes', () => {
    expect(normalizeDescription(leverJoined)).toBe(normalizeDescription(reformattedHtml));
    expect(normalizeDescription(ashbyMarkdown)).toBe(normalizeDescription(reformattedHtml));
  });

  it('changes when the actual content changes', () => {
    expect(normalizeDescription(`${reformattedHtml}<p>Also: 5+ years required.</p>`)).not.toBe(
      normalizeDescription(reformattedHtml),
    );
  });
});

// GATE: idempotency property — normalize(normalize(x)) === normalize(x).
describe('idempotency over a generated input set', () => {
  const companyParts = ['Acme', 'incident.io', 'Ben & Jerry', 'Cisco', 'Foo'];
  const companySuffixes = ['', ' Inc.', ', LLC', ' Co., Ltd.', ' GmbH', ' Holdings'];
  const titleParts = ['Product Designer', 'Software Engineer, Backend', 'UI/UX Designer'];
  const titleSuffixes = [
    '',
    ' II',
    ' (Remote)',
    ' [REQ-1042]',
    ' - San Francisco, CA',
    ' #45210',
    ' — Summer 2026',
  ];
  const locationParts = [
    'San Francisco, CA',
    'Remote',
    'Anywhere in the World',
    'Berlin, Germany',
    'New York, NY',
    'Sacramento',
    '',
  ];
  const descriptionParts = [
    '<p>Hello&nbsp;world</p>',
    '&lt;p&gt;Hello &amp;amp; world&lt;/p&gt;',
    '## Heading\n\n- one\n- two',
    '   ragged   \n\n text ',
    '<div><br/>&#39;quoted&#39;</div>',
  ];

  const companies = companyParts.flatMap((c) => companySuffixes.map((s) => `${c}${s}`));
  const titles = titleParts.flatMap((t) => titleSuffixes.map((s) => `${t}${s}`));
  const descriptions = descriptionParts.flatMap((a) =>
    descriptionParts.map((b) => `${a}\n${b}`),
  );

  it.each(companies)('normalizeCompany(%j) is idempotent', (input) => {
    const once = normalizeCompany(input);
    expect(normalizeCompany(once)).toBe(once);
  });

  it.each(titles)('normalizeTitle(%j) is idempotent', (input) => {
    const once = normalizeTitle(input);
    expect(normalizeTitle(once)).toBe(once);
  });

  it.each(descriptions)('normalizeDescription is idempotent', (input) => {
    const once = normalizeDescription(input);
    expect(normalizeDescription(once)).toBe(once);
  });

  // normalizeLocation returns a record, so idempotency means: feeding its own city_norm
  // back in resolves to the same city_norm.
  it.each(locationParts)('normalizeLocation(%j) city_norm is stable', (input) => {
    const once = normalizeLocation(input);
    if (once.city_norm === null) return;
    expect(normalizeLocation(once.city_norm).city_norm).toBe(once.city_norm);
  });

  it('covers every alias spelling', () => {
    const aliases = Object.values(CITY_ALIASES).flatMap((entry) => entry.aliases);
    expect(aliases.length).toBeGreaterThanOrEqual(19);
    for (const alias of aliases) {
      expect(normalizeLocation(alias).city_norm).not.toBeNull();
    }
    for (const city of CALIFORNIA_CITIES) {
      expect(normalizeLocation(city).state).toBe('CA');
    }
  });
});
