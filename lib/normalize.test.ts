import { describe, expect, it } from 'vitest';

import { enrichmentCacheKey } from './hash';
import {
  CALIFORNIA_CITIES,
  CITY_ALIASES,
  normalizeCompany,
  normalizeDescription,
  normalizeLocation,
  normalizeTitle,
} from './normalize';

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

// FINDING B — the enrichment cache key hashes NORMALIZED text, never the raw body.
describe('enrichmentCacheKey', () => {
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

  it('is a sha256 hex digest', () => {
    expect(enrichmentCacheKey(reformattedHtml)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hits the same cache row when HTML and whitespace are reformatted', () => {
    expect(enrichmentCacheKey(greenhouseEscapedHtml)).toBe(enrichmentCacheKey(reformattedHtml));
  });

  it('hits the same cache row across the Greenhouse, Lever and Ashby shapes', () => {
    expect(enrichmentCacheKey(leverJoined)).toBe(enrichmentCacheKey(reformattedHtml));
    expect(enrichmentCacheKey(ashbyMarkdown)).toBe(enrichmentCacheKey(reformattedHtml));
  });

  it('changes when the actual content changes', () => {
    expect(enrichmentCacheKey(`${reformattedHtml}<p>Also: 5+ years required.</p>`)).not.toBe(
      enrichmentCacheKey(reformattedHtml),
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
