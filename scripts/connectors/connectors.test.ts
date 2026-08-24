/**
 * One integration test per connector, against a RECORDED FIXTURE. The whole suite runs with
 * the network unplugged; the fixtures were recorded from a live run with
 * `npm run ingest -- --dry-run --record --only=<name>`.
 */

import { describe, expect, it } from 'vitest';

import { extract } from '../../lib/extract.ts';
import { normalizeCompany, normalizeTitle } from '../../lib/normalize.ts';
import { RobotsDisallowedError } from '../../lib/runtime.ts';
import type { Connector, ConnectorContext, ConnectorPosting, Runtime } from '../../lib/runtime.ts';

import { ashby, greenhouse, lever, recruitee, smartrecruiters, teamtailor, workable, workday, workdayPostedAt } from './ats.ts';
import { amazon } from './amazon.ts';
import { braintrust, himalayas, hn, jobicy, muse, remoteok, remotive, workingnomads } from './agg.ts';
import { fixtureRuntime, loadFixture, recordingRuntime, type Fixture } from './fixtures.ts';
import { adzuna, careerjet, jooble, usajobs } from './keyed.ts';
import { parseReadmeTable, simplifyInternships } from './repo.ts';
import { designjobsCareers, dribbble, jobspresso, weworkremotely, weworkremotelyDesign } from './rss.ts';

/** A runtime that answers every request with one canned body. */
function stubRuntime(body: string): Runtime {
  return {
    fetchText: async () => body,
    fetchJson: async <T,>(): Promise<T> => JSON.parse(body) as T,
    isAllowed: async () => true,
  };
}

function replay(name: string): {
  context: ConnectorContext;
  logs: Record<string, unknown>[];
  degraded: string[];
} {
  const logs: Record<string, unknown>[] = [];
  const degraded: string[] = [];
  return {
    logs,
    degraded,
    context: {
      runtime: fixtureRuntime(loadFixture(name)),
      env: {},
      log: (record) => logs.push(record),
      degraded: (reason) => degraded.push(reason),
    },
  };
}

/** Every connector's output must survive the same trip into `lib/dedupe.ts`. */
function expectCanonicalShape(posting: ConnectorPosting, expected: Connector): void {
  expect(posting.source).toBe(expected.name);
  expect(posting.sourceKind).toBe(expected.kind);
  expect(posting.sourceUrl).toMatch(/^https?:\/\//);
  expect(Number.isFinite(posting.postedAt)).toBe(true);
  // posted_at has to be a plausible date, not a stray sentinel that ages the row out.
  expect(posting.postedAt).toBeGreaterThan(Date.parse('2015-01-01'));
  expect(posting.postedAt).toBeLessThan(Date.now() + 7 * 86_400_000);
  expect(normalizeCompany(posting.company).length).toBeGreaterThan(0);
  expect(normalizeTitle(posting.title).length).toBeGreaterThan(0);
}

/**
 * `simplify-internships` is the one exception to "non-empty description": the SimplifyJobs
 * README table has no job body to read — only company, role, location and an apply link.
 * Padding it out with its own cells restated as prose would be inventing a description; the
 * field stays empty and fills in from a higher-priority source when the job merges.
 */
/**
 * `dribbble` is the second: its feed ships `<description><![CDATA[]]></description>` on every
 * item — the whole posting is the one sentence in the title. Same rule as above, an empty
 * description beats an invented one, and the title alone is enough for classification.
 */
/**
 * `workday` is the third: its list endpoint returns no body at all, and the per-posting detail
 * endpoint would be one request each — 2,000 for NVIDIA alone. Title-only, like the two above.
 */
const NO_DESCRIPTION_AVAILABLE = new Set(['simplify-internships', 'dribbble', 'workday']);

const RECORDED: Connector[] = [
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workable,
  recruitee,
  hn,
  remoteok,
  workingnomads,
  weworkremotely,
  weworkremotelyDesign,
  dribbble,
  braintrust,
  himalayas,
  jobspresso,
  simplifyInternships,
  workday,
  teamtailor,
  amazon,
  jobicy,
  muse,
  designjobsCareers,
];

describe.each(RECORDED.map((connector) => [connector.name, connector] as const))(
  '%s (recorded fixture)',
  (name, connector) => {
    it('returns at least one posting in the canonical shape', async () => {
      const { context } = replay(name);
      const results = await connector.fetch(context);

      expect(results.length).toBeGreaterThan(0);
      for (const posting of results) expectCanonicalShape(posting, connector);

      if (!NO_DESCRIPTION_AVAILABLE.has(name)) {
        expect(results.some((posting) => posting.description.length > 0)).toBe(true);
      }
    });

    it('yields descriptions with no HTML tags or entities left in them', async () => {
      const { context } = replay(name);
      for (const posting of await connector.fetch(context)) {
        expect(posting.description).not.toMatch(/<\/?[a-z][^<>]*>/i);
        expect(posting.description).not.toMatch(/&(amp|lt|gt|quot|#\d+);/);
      }
    });
  },
);

describe('ATS per-target isolation (Phase 3 gate)', () => {
  it('a target that fails logs ONE failure and does not abort the connector', async () => {
    // Only the first boards are recorded, so every other registry token behaves exactly like
    // a dead one: the connector logs each and still returns the boards that answered.
    const { context, logs } = replay('greenhouse');
    const results = await greenhouse.fetch(context);

    const failures = logs.filter((line) => line.status === 'error');
    expect(failures.length).toBeGreaterThan(0);
    for (const failure of failures) {
      expect(failure.connector).toBe('greenhouse');
      expect(failure.company).toBeTruthy();
    }
    expect(results.length).toBeGreaterThan(0);
  });

  it('fails the connector only when EVERY target failed', async () => {
    const degraded: string[] = [];
    const context: ConnectorContext = {
      runtime: fixtureRuntime({}),
      env: {},
      log: () => {},
      degraded: (reason) => degraded.push(reason),
    };
    await expect(greenhouse.fetch(context)).rejects.toThrow(/all \d+ greenhouse targets failed/);
  });
});

describe('keyed connectors', () => {
  const KEYS: Record<string, Record<string, string>> = {
    adzuna: { ADZUNA_APP_ID: 'a', ADZUNA_APP_KEY: 'b' },
    careerjet: { CAREERJET_AFFID: 'a' },
    jooble: { JOOBLE_KEY: 'a' },
    usajobs: { USAJOBS_KEY: 'a', USAJOBS_EMAIL: 'b@c.d' },
  };

  /** The two whose key is the only thing standing between them and a run. */
  const KEYED = [careerjet, jooble];
  /**
   * The two that are refused by robots.txt on the API host itself, so no key can enable them.
   * `api.adzuna.com` and `data.usajobs.gov` both publish `User-agent: * / Disallow: /`
   * (checked 2026-08-20), which the runtime's robots check honours on every call. Before they
   * were skipped for this reason, supplying a key produced a RobotsDisallowedError per cycle
   * instead of postings.
   */
  const ROBOTS_BLOCKED = [adzuna, usajobs];

  it.each(KEYED)('$name skips when its key is absent', (connector) => {
    const reason = connector.skip?.({});
    expect(reason).toMatch(/not set in \.env\.local/);
    // The notice must name the variable to set — and never the value of anything.
    expect(reason).toMatch(/[A-Z_]{4,}/);
  });

  it.each(KEYED)('$name runs once its key is present', (connector) => {
    expect(connector.skip?.(KEYS[connector.name])).toBeNull();
  });

  it.each(ROBOTS_BLOCKED)('$name skips for robots even WITH a key present', (connector) => {
    const reason = connector.skip?.(KEYS[connector.name]);
    // The whole point: a key does not unlock it, and the notice says why rather than
    // implying a missing variable.
    expect(reason).toMatch(/robots\.txt disallows/);
    expect(reason).not.toMatch(/not set in \.env\.local/);
  });

  it.each(ROBOTS_BLOCKED)('$name names the host that refused it', (connector) => {
    expect(connector.skip?.({})).toMatch(/^(api\.adzuna\.com|data\.usajobs\.gov)/);
  });
});

describe('fixture recorder', () => {
  it('refuses to record a response whose URL carries a credential', async () => {
    const sink: Fixture = {};
    const recorder = recordingRuntime(stubRuntime('{"jobs":[]}'), sink);

    // Query-string credential (Adzuna shape).
    await recorder.fetchText('https://api.test/search?app_key=SUPERSECRET');
    // Path credential (Jooble shape) — invisible to a query-string check, which is exactly
    // why those sources pass `redactUrl`.
    await recorder.fetchText('https://jooble.test/api/SUPERSECRET', {
      redactUrl: 'https://jooble.test/api/[key]',
    });

    expect(JSON.stringify(sink)).not.toContain('SUPERSECRET');
    expect(Object.keys(sink)).toEqual([]);
  });

  it('does record an ordinary URL', async () => {
    const sink: Fixture = {};
    const recorder = recordingRuntime(stubRuntime('{"jobs":[{"a":1},{"a":2},{"a":3}]}'), sink);
    await recorder.fetchText('https://api.test/jobs?content=true');
    expect(Object.keys(sink)).toEqual(['https://api.test/jobs?content=true']);
    // ...trimmed, so a full board does not become a megabyte in the repo.
    expect(JSON.parse(sink['https://api.test/jobs?content=true']).jobs).toHaveLength(2);
  });
});

describe('remotive', () => {
  it('is disabled because remotive.com/robots.txt disallows /api/*', () => {
    expect(remotive.skip?.({})).toMatch(/robots\.txt disallows \/api\/\*/);
  });
});

describe('simplify README table parser', () => {
  const NOW = Date.parse('2026-08-18T00:00:00Z');

  it('carries the company down through ↳ rows', () => {
    const rows = parseReadmeTable(
      [
        '<table><thead><tr><th>Company</th></tr></thead><tbody>',
        '<tr><td><strong><a href="https://simplify.jobs/c/Acme">Acme</a></strong></td>',
        '<td>Software Engineer Intern</td><td>Atlanta, GA</td>',
        '<td><a href="https://acme.test/apply/1?utm_source=Simplify&ref=Simplify">Apply</a></td><td>0d</td></tr>',
        '<tr><td>↳</td><td>Data Science Intern</td><td>Phoenix, AZ</td>',
        '<td><a href="https://acme.test/apply/2">Apply</a></td><td>3d</td></tr>',
        '<tr><td>↳</td><td>Closed Role</td><td>Remote</td><td>🔒</td><td>1mo</td></tr>',
        '</tbody></table>',
      ].join('\n'),
      NOW,
    );

    expect(rows).toHaveLength(2); // the locked row has no apply link
    expect(rows.map((row) => row.company)).toEqual(['Acme', 'Acme']);
    expect(rows[1].title).toBe('Data Science Intern');
    // Simplify's referral params are stripped so the same row yields the same URL every run.
    expect(rows[0].sourceUrl).toBe('https://acme.test/apply/1');
    expect(rows[1].postedAt).toBe(NOW - 3 * 86_400_000);
  });
});

describe('HN row marking', () => {
  it('tags every row `hn` so a later LLM pass can find them all', async () => {
    const { context } = replay('hn');
    const results = await hn.fetch(context);
    expect(results.length).toBeGreaterThan(0);
    for (const posting of results) expect(posting.source).toBe('hn');
  });

  it('logs how many comments it refused to extract rather than guessing', async () => {
    const { context, logs } = replay('hn');
    await hn.fetch(context);
    const summary = logs.find((line) => 'skippedUnextractable' in line);
    expect(summary?.skippedUnextractable).toBeTypeOf('number');
  });
});

/**
 * The four design-and-freelance sources added for the Design tab. The shared suite above
 * already proves they produce the canonical shape; these cover the per-source logic that
 * suite cannot see — a title parsed out of a sentence, an employment type carried through
 * from a field rather than guessed from prose, and a location chosen from several.
 */
/**
 * A minimal but *valid* RSS 2.0 document. `rss-parser` refuses a bare `<rss>` with "Feed not
 * recognized as RSS 1 or 2", and `dc:creator` is dropped unless its namespace is declared.
 */
function rssFeed(items: string): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Feed</title>` +
    `${items}</channel></rss>`
  );
}

describe('design and freelance sources', () => {
  describe('dribbble', () => {
    it('parses company, role and location out of the one sentence it publishes', async () => {
      const results = await dribbble.fetch(replay('dribbble').context);
      // No title may keep the scaffolding sentence: that would mean the parse fell through.
      for (const posting of results) {
        expect(posting.title, `unparsed title: ${posting.title}`).not.toContain(
          'is hiring for a position of',
        );
      }
      expect(results.some((posting) => /,\s*[A-Z]{2}$/.test(posting.location ?? ''))).toBe(true);
    });

    it('keeps every item, including the ones the sentence parse misses', async () => {
      const fixture = loadFixture('dribbble');
      const feed = Object.values(fixture)[0];
      const items = (feed.match(/<item>/g) ?? []).length;
      expect(items).toBeGreaterThan(0);
      expect((await dribbble.fetch(replay('dribbble').context)).length).toBe(items);
    });

    it('reads the `anywhere` form as remote rather than as a place', async () => {
      const stub = await dribbble.fetch({
        ...replay('dribbble').context,
        runtime: stubRuntime(
          rssFeed(
            `<item><title>KAP is hiring for a position of Graphic Designer anywhere</title>` +
              `<link>https://dribbble.com/jobs/1</link><dc:creator>KAP</dc:creator>` +
              `<pubDate>Tue, 18 Aug 2026 03:34:59 -0400</pubDate></item>`,
          ),
        ),
      });
      expect(stub[0].title).toBe('Graphic Designer');
      expect(stub[0].location).toBe('Remote');
    });
  });

  describe('weworkremotely-design', () => {
    it('carries the feed\'s own <type> through instead of leaving it to the prose', async () => {
      const results = await weworkremotelyDesign.fetch(replay('weworkremotely-design').context);
      const types = results.map((posting) => posting.sourceFields?.employmentType);
      expect(types.filter((type) => type === 'full-time').length).toBeGreaterThan(0);
    });

    /**
     * Contract is 2 rows of the live feed's 82, and a committed fixture is trimmed to three
     * items, so the value that actually matters here is pinned against a stub. It is the
     * reason this connector exists: WWR is the only verified source of contract design work
     * in any volume, and `<type>` is the only place it says so.
     */
    it.each([
      ['Contract', 'contract'],
      ['Full-Time', 'full-time'],
      ['Freelance', 'freelance'],
      ['Internship', 'internship'],
      ['Something New', undefined],
    ])('maps <type>%s</type> to %s', async (published, expected) => {
      const results = await weworkremotelyDesign.fetch({
        ...replay('weworkremotely-design').context,
        runtime: stubRuntime(
          rssFeed(
            `<item><title>Studio: Brand Designer</title>` +
              `<link>https://weworkremotely.com/remote-jobs/1</link><region>California</region>` +
              `<type>${published}</type><category>Design</category>` +
              `<pubDate>Tue, 18 Aug 2026 03:34:59 -0400</pubDate></item>`,
          ),
        ),
      });
      // An unmapped value stays undefined so the prose heuristics still get their turn —
      // never guessed into a type the feed did not state.
      expect(results[0].sourceFields?.employmentType).toBe(expected);
    });

    it('is the same board as the general feed, reaching further into design', async () => {
      const design = await weworkremotelyDesign.fetch(replay('weworkremotely-design').context);
      const general = await weworkremotely.fetch(replay('weworkremotely').context);
      expect(design.length).toBeGreaterThan(
        general.filter((posting) => /design/i.test(posting.title ?? '')).length,
      );
    });
  });

  describe('braintrust', () => {
    it('marks every posting freelance from the field, not from the description', async () => {
      const results = await braintrust.fetch(replay('braintrust').context);
      expect(results.length).toBeGreaterThan(0);
      for (const posting of results) {
        expect(posting.sourceFields?.employmentType).toBe('freelance');
        expect(posting.sourceUrl).toMatch(/^https:\/\/app\.usebraintrust\.com\/jobs\/\d+\/$/);
      }
    });

    /**
     * The reason the description is assembled at all. Braintrust publishes no prose, and
     * `extract.ts` reads pay out of prose — so if the rate is not written in a form the pay
     * parser recognizes, a $130/hour engagement stores with no rate and the pay-rate column
     * is empty for every freelance row.
     */
    it('writes the rate in a form the pay extractor actually parses', async () => {
      const results = await braintrust.fetch(replay('braintrust').context);
      const withRate = results.filter((posting) => posting.description.includes('Rate: $'));
      expect(withRate.length, 'fixture has no priced role to test with').toBeGreaterThan(0);
      for (const posting of withRate) {
        const { pay_rate, paid } = extract({ title: posting.title ?? '', description: posting.description });
        expect(pay_rate, `no pay parsed from: ${posting.description.slice(0, 80)}`).not.toBeNull();
        expect(pay_rate!.min).toBeGreaterThan(0);
        expect(pay_rate!.period).toBe('hour');
        expect(paid).toBe(true);
      }
    });

    it('prefers a US location when a role is open in several places', async () => {
      const fixture = loadFixture('braintrust');
      const body = JSON.parse(Object.values(fixture)[0]) as {
        results: { locations?: { location?: string; country?: string }[] }[];
      };
      const multi = body.results.findIndex((job) => (job.locations ?? []).length > 1);
      expect(multi, 'fixture has no multi-location role to test with').toBeGreaterThanOrEqual(0);

      const results = await braintrust.fetch(replay('braintrust').context);
      const chosen = results[multi].location;
      const us = body.results[multi].locations!.filter((l) => l.country === 'US');
      if (us.length > 0) expect(us.map((l) => l.location)).toContain(chosen);
    });
  });

  describe('himalayas', () => {
    /**
     * Paged against a stub, not against the fixture: `recordingRuntime` commits at most two
     * URLs and trims each body, so a recorded fixture cannot show a 20-row page at all, let
     * alone five of them. The stub answers every offset with a full page, which is what the
     * live endpoint does.
     */
    const page = (count: number) =>
      JSON.stringify({
        limit: 20,
        offset: 0,
        totalCount: 100_000,
        jobs: Array.from({ length: count }, (_, i) => ({
          title: `Product Designer ${i}`,
          companyName: 'Stub Co',
          employmentType: 'Full Time',
          locationRestrictions: ['United States'],
          pubDate: 1_787_000_000,
          applicationLink: `https://himalayas.app/companies/stub/jobs/designer-${i}`,
          description: 'Design work on a product team.',
        })),
      });

    it('pages past the 20-row cap the endpoint enforces, and stops at five pages', async () => {
      // The endpoint echoes `limit: 20` back however large a limit it is sent, so more than
      // 20 postings can only come from the offset loop — and an unbounded loop against a board
      // of 100k postings would never stop, so the cap is the assertion that matters.
      const results = await himalayas.fetch({ ...replay('himalayas').context, runtime: stubRuntime(page(20)) });
      expect(results.length).toBe(100);
    });

    it('stops early when a page comes back short rather than asking for the next one', async () => {
      const results = await himalayas.fetch({ ...replay('himalayas').context, runtime: stubRuntime(page(7)) });
      expect(results.length).toBe(7);
    });

    it("maps its own spelling of the employment type onto the schema's", async () => {
      const results = await himalayas.fetch({ ...replay('himalayas').context, runtime: stubRuntime(page(3)) });
      expect(results.every((posting) => posting.sourceFields?.employmentType === 'full-time')).toBe(true);
    });

    it('keeps a location restriction rather than flattening everything to Remote', async () => {
      const results = await himalayas.fetch({ ...replay('himalayas').context, runtime: stubRuntime(page(3)) });
      expect(results[0].location).toBe('United States');
    });

    it('falls back to Remote only when the board states no restriction', async () => {
      const body = JSON.stringify({
        jobs: [{ title: 'Brand Designer', companyName: 'Stub Co', employmentType: 'Contract', pubDate: 1_787_000_000, applicationLink: 'https://himalayas.app/x', description: 'Brand work.' }],
      });
      const results = await himalayas.fetch({ ...replay('himalayas').context, runtime: stubRuntime(body) });
      expect(results[0].location).toBe('Remote');
      expect(results[0].sourceFields?.employmentType).toBe('contract');
    });
  });
});

/**
 * The two employer-board connectors added so large companies arrive from their own listing
 * rather than second-hand through an internship aggregator.
 */
describe('employer boards', () => {
  /**
   * The one piece of the Workday connector that can be wrong without failing: it publishes no
   * timestamp on the list endpoint, only the phrase shown in its UI, and `posted_at` is the
   * FIRST sort key on both tabs. A bad parse does not error, it silently mis-dates a posting.
   */
  describe('workdayPostedAt', () => {
    const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
    const days = (n: number) => NOW - n * 24 * 60 * 60 * 1000;

    it.each([
      ['Posted Today', NOW],
      ['Posted Yesterday', days(1)],
      ['Posted 5 Days Ago', days(5)],
      ['Posted 1 Day Ago', days(1)],
      // NVIDIA's board floors at this phrase; it must not read as 30 days *plus* something.
      ['Posted 30+ Days Ago', days(30)],
      ['Just posted', NOW],
    ])('reads %s', (phrase, expected) => {
      expect(workdayPostedAt(phrase, NOW)).toBe(expected);
    });

    it('returns NaN for a phrase it does not know rather than guessing a date', () => {
      // `dedupePostings` already falls back when nothing parsed. A wrong date outranks a
      // missing one on a recency-sorted table, so guessing is the worse failure.
      for (const phrase of ['Posted Sometime', '', undefined, 'Reposted']) {
        expect(Number.isNaN(workdayPostedAt(phrase, NOW)), String(phrase)).toBe(true);
      }
    });

    it('is monotonic — an older phrase never sorts newer', () => {
      const ages = ['Posted Today', 'Posted Yesterday', 'Posted 5 Days Ago', 'Posted 30+ Days Ago'].map(
        (p) => workdayPostedAt(p, NOW),
      );
      expect(ages).toEqual([...ages].sort((a, b) => b - a));
    });
  });

  describe('workday', () => {
    it('builds the posting URL from the tenant, not from the API host', async () => {
      const results = await workday.fetch(replay('workday').context);
      expect(results.length).toBeGreaterThan(0);
      for (const posting of results) {
        // The API lives under /wday/cxs/; a human-facing URL must not.
        expect(posting.sourceUrl).not.toContain('/wday/cxs/');
        expect(posting.sourceUrl).toMatch(/^https:\/\/[a-z0-9-]+\.wd\d+\.myworkdayjobs\.com\/.+\/job\//);
      }
    });

    it('is priority-1 ATS, so its URL beats an aggregator syndicating the same job', async () => {
      for (const posting of await workday.fetch(replay('workday').context)) {
        expect(posting.sourceKind).toBe('ats');
      }
    });

    /**
     * The real shapes, taken from a live page of workday.wd5: a posting spanning sites reports
     * the count and keeps its primary site only in `externalPath`, and some boards separate with
     * periods. 353 live rows had a *city* called "2 locations" — and `city_norm` is a
     * `dedupe_key` component, so a count was acting as a place identity.
     */
    it('reads through a location GROUP to the primary site', async () => {
      const body = JSON.stringify({
        total: 4,
        jobPostings: [
          { title: 'Manager, Sales Development', locationsText: '6 Locations', externalPath: '/job/USA-GA-Atlanta/Manager--Sales-Development_JR-010841', postedOn: 'Posted Today' },
          { title: 'Partner BI Analyst', locationsText: '3 Locations', externalPath: '/job/USA-TX-Austin/Partner-Business-Intelligence-Analyst_JR-1', postedOn: 'Posted Today' },
          { title: 'Software Development Engineer', locationsText: 'USA.VA.Reston', externalPath: '/job/USAVAReston/Software-Development-Engineer_JR-2', postedOn: 'Posted Today' },
          { title: 'Senior Financial Analyst', locationsText: 'Costa Rica', externalPath: '/job/Costa-Rica/Senior-Financial-Analyst_JR-0109274', postedOn: 'Posted Today' },
        ],
      });
      const results = await workday.fetch({ ...replay('workday').context, runtime: stubRuntime(body) });
      const seen = new Map(results.map((posting) => [posting.title, posting.location]));

      // A count is never the location; the path carries the real one.
      expect(seen.get('Manager, Sales Development')).toBe('USA-GA-Atlanta');
      expect(seen.get('Partner BI Analyst')).toBe('USA-TX-Austin');
      // Period dialect, converted so a comma splitter can reach it.
      expect(seen.get('Software Development Engineer')).toBe('USA, VA, Reston');
      // A location the board reported properly is passed through untouched.
      expect(seen.get('Senior Financial Analyst')).toBe('Costa Rica');

      for (const location of seen.values()) expect(location).not.toMatch(/\d+\s+locations?/i);
    });

    it('keeps the location string the board reported', async () => {
      const results = await workday.fetch(replay('workday').context);
      expect(results.some((posting) => (posting.location ?? '').length > 0)).toBe(true);
    });
  });

  describe('amazon', () => {
    it('normalizes the employment type from the schedule and the intern flag', async () => {
      const results = await amazon.fetch(replay('amazon').context);
      expect(results.length).toBeGreaterThan(0);
      const types = new Set(results.map((posting) => posting.sourceFields?.employmentType));
      for (const type of types) {
        if (type !== undefined) expect(['full-time', 'part-time', 'internship']).toContain(type);
      }
    });

    it('prefers the normalized location, which parses, over the display form', async () => {
      // "US, CO, Denver" leads with a country code that reads as a city segment;
      // "Denver, Colorado, USA" is the form `normalizeLocation` can use.
      const results = await amazon.fetch(replay('amazon').context);
      const withLocation = results.filter((posting) => posting.location);
      expect(withLocation.length).toBeGreaterThan(0);
      for (const posting of withLocation) {
        expect(posting.location, posting.location ?? '').not.toMatch(/^US,\s/);
      }
    });

    it('stores every location as reported — no geography filter at the source', async () => {
      // The endpoint accepts a country filter and this connector deliberately does not use it:
      // geo is a view concern, and a filter applied during ingest cannot be lifted later.
      const results = await amazon.fetch(replay('amazon').context);
      const countries = new Set(
        results.map((posting) => (posting.location ?? '').split(',').pop()?.trim()).filter(Boolean),
      );
      expect(countries.size).toBeGreaterThan(1);
    });

    it('points at amazon.jobs itself', async () => {
      for (const posting of await amazon.fetch(replay('amazon').context)) {
        expect(posting.sourceUrl).toMatch(/^https:\/\/www\.amazon\.jobs\/en\/jobs\//);
        expect(posting.sourceKind).toBe('ats');
      }
    });
  });
});

/**
 * Amazon labels its internships `job_schedule_type: "full-time"` and leaves `is_intern` null, so
 * the schedule field cannot be trusted for this. `sourceFields` is read before the prose
 * heuristics, which makes a wrong structured value worse than none — it outranks the title parse
 * that would have been right.
 */
describe('amazon employment type', () => {
  const stub = (jobs: unknown[]) => stubRuntime(JSON.stringify({ hits: jobs.length, jobs }));
  const job = (title: string, extra: Record<string, unknown> = {}) => ({
    title,
    job_path: '/en/jobs/1/x',
    posted_date: 'August 19, 2026',
    job_schedule_type: 'full-time',
    is_intern: null,
    description: 'Build things.',
    normalized_location: 'Seattle, Washington, USA',
    ...extra,
  });

  it.each([
    'Software Development Engineer Intern',
    'Operations Engineer Internship',
    'Robotics - Software Development Engineer Intern/Co-op - 2026',
    '【Class of 2029／Internship】Applied Scientists',
  ])('reads %s as an internship despite the full-time schedule', async (title) => {
    const results = await amazon.fetch({ ...replay('amazon').context, runtime: stub([job(title)]) });
    expect(results[0]?.sourceFields?.employmentType).toBe('internship');
  });

  it('still uses the schedule when the title says nothing', async () => {
    const results = await amazon.fetch({ ...replay('amazon').context, runtime: stub([job('Software Development Engineer II')]) });
    expect(results[0]?.sourceFields?.employmentType).toBe('full-time');
  });

  it('does not mistake a word merely containing "intern" for an internship', async () => {
    const results = await amazon.fetch({
      ...replay('amazon').context,
      runtime: stub([job('Internal Tools Engineer'), job('International Expansion Engineer')]),
    });
    for (const posting of results) expect(posting.sourceFields?.employmentType).toBe('full-time');
  });
});

describe('jobicy', () => {
  it('carries its own employment type rather than leaving it to the prose', async () => {
    const results = await jobicy.fetch(replay('jobicy').context);
    expect(results.length).toBeGreaterThan(0);
    for (const posting of results) {
      const type = posting.sourceFields?.employmentType;
      if (type !== undefined) expect(['full-time', 'part-time', 'contract']).toContain(type);
    }
  });

  /**
   * `jobGeo` is a list of eligible regions ("Europe,  USA" — the doubled spaces are theirs),
   * not one place. Storing the whole string would put "Europe,  USA" through
   * `normalizeLocation` as a single city and land it nowhere.
   */
  it('takes one region from the eligibility list, not the whole string', async () => {
    for (const posting of await jobicy.fetch(replay('jobicy').context)) {
      expect(posting.location, posting.location ?? '').not.toContain(',');
    }
  });

  it('falls back to Anywhere rather than a null location', async () => {
    const stub = await jobicy.fetch({
      ...replay('jobicy').context,
      runtime: stubRuntime(
        JSON.stringify({
          jobCount: 1,
          jobs: [{ id: 1, url: 'https://jobicy.com/jobs/1-x', jobTitle: 'Product Designer', companyName: 'Stub', pubDate: '2026-08-20T00:00:00+00:00', jobDescription: 'Design work.' }],
        }),
      ),
    });
    expect(stub[0].location).toBe('Anywhere');
  });

  it('is aggregator tier, so an ATS keeps canonical_url when the same job arrives twice', async () => {
    for (const posting of await jobicy.fetch(replay('jobicy').context)) {
      expect(posting.sourceKind).toBe('aggregator');
      expect(posting.sourceUrl).toMatch(/^https:\/\/jobicy\.com\/jobs\//);
    }
  });
});

describe('teamtailor', () => {
  /**
   * The bug this connector was written around: Teamtailor answers JSON Feed 1.1, so the
   * postings are under `items`. A reader looking for `data` or `jobs` — the shape every other
   * ATS here uses — reports an empty board on a board with 28 openings.
   */
  it('reads the JSON Feed `items` array, not `data` or `jobs`', async () => {
    const results = await teamtailor.fetch(replay('teamtailor').context);
    expect(results.length).toBeGreaterThan(0);
  });

  /**
   * The reason it is worth having at all. The feed's own fields carry no place; the embedded
   * schema.org JobPosting does, and the Design tab shows target locations only — a posting
   * with no parseable city never appears there.
   */
  it('takes the city from the embedded JobPosting, which is the only place it exists', async () => {
    const results = await teamtailor.fetch(replay('teamtailor').context);
    const located = results.filter((posting) => posting.location);
    expect(located.length).toBeGreaterThan(0);
    for (const posting of located) expect(posting.location).not.toMatch(/^\s*$/);
  });

  it('keeps one place for a posting listed in several', async () => {
    const stub = await teamtailor.fetch({
      ...replay('teamtailor').context,
      runtime: stubRuntime(
        JSON.stringify({
          version: 'https://jsonfeed.org/version/1.1',
          items: [
            {
              id: '1',
              title: 'Senior Digital Designer',
              url: 'https://koto.teamtailor.com/jobs/1-x',
              date_published: '2026-08-18T00:00:00+01:00',
              content_html: '<h3>The Role</h3><p>Brand work.</p>',
              _jobposting: {
                datePosted: '2026-08-18',
                jobLocation: [
                  { address: { addressLocality: 'Los Angeles', addressRegion: 'CA', addressCountry: 'US' } },
                  { address: { addressLocality: 'Berlin', addressCountry: 'DE' } },
                ],
              },
            },
          ],
        }),
      ),
    });
    expect(stub[0].location).toBe('Los Angeles, CA, US');
    expect(stub[0].location).not.toContain('Berlin');
  });

  it('is priority-1 ATS', async () => {
    for (const posting of await teamtailor.fetch(replay('teamtailor').context)) {
      expect(posting.sourceKind).toBe('ats');
    }
  });
});

/**
 * `normalizeLocation` reads a trailing two-letter code as a US state on purpose, so `ca` means
 * California. Passing `addressCountry` verbatim therefore filed Koto's Berlin internship under
 * Delaware — and a Toronto role under California, which the Design tab's location rule shows.
 */
describe('teamtailor location, and the country-code collision', () => {
  const feed = (address: Record<string, string>) =>
    JSON.stringify({
      version: 'https://jsonfeed.org/version/1.1',
      items: [
        {
          id: '1',
          title: 'Brand Designer',
          url: 'https://koto.teamtailor.com/jobs/1-x',
          date_published: '2026-08-18T00:00:00+01:00',
          content_html: '<p>Brand work.</p>',
          _jobposting: { datePosted: '2026-08-18', jobLocation: [{ address }] },
        },
      ],
    });

  const locationOf = async (address: Record<string, string>) =>
    (
      await teamtailor.fetch({
        ...replay('teamtailor').context,
        runtime: stubRuntime(feed(address)),
      })
    )[0].location;

  it.each([
    [{ addressLocality: 'Berlin', addressCountry: 'DE' }, 'Berlin'],
    [{ addressLocality: 'Toronto', addressCountry: 'CA' }, 'Toronto'],
    [{ addressLocality: 'Mumbai', addressCountry: 'IN' }, 'Mumbai'],
  ])('drops a two-letter foreign country code (%j)', async (address, expected) => {
    expect(await locationOf(address as Record<string, string>)).toBe(expected);
  });

  it('keeps the region and country for a US posting, where the region really is a state', async () => {
    expect(
      await locationOf({ addressLocality: 'Los Angeles', addressRegion: 'CA', addressCountry: 'US' }),
    ).toBe('Los Angeles, CA, US');
  });

  it('keeps a country that is spelled out, since a name cannot be read as a state', async () => {
    expect(await locationOf({ addressLocality: 'Berlin', addressCountry: 'Germany' })).toBe('Berlin, Germany');
  });
});

// The apply button lands on the form, not the description (fixtures are recorded live).
describe('direct application URLs', () => {
  it('ashby carries applyUrl from the list API', async () => {
    const { context } = replay('ashby');
    const posts = await ashby.fetch(context);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.applyUrl).toBe(`${post.sourceUrl}/application`);
  });

  it('lever derives /apply from every hostedUrl', async () => {
    const { context } = replay('lever');
    const posts = await lever.fetch(context);
    expect(posts.length).toBeGreaterThan(0);
    for (const post of posts) expect(post.applyUrl).toBe(`${post.sourceUrl}/apply`);
  });
});

// When every target of an ATS connector is refused by robots.txt, the aggregate error names
// the cause instead of discarding it — that is what lets `npm run status` say `refused`.
describe('a fully robots-refused connector says so', () => {
  it('smartrecruiters throws a refusal, not a generic failure', async () => {
    const refusing: Runtime = {
      fetchText: async (url) => { throw new RobotsDisallowedError(url); },
      fetchJson: async (url: string) => { throw new RobotsDisallowedError(url); },
      isAllowed: async () => false,
    };
    const context = { runtime: refusing, env: {}, log: () => {}, degraded: () => {} };
    await expect(smartrecruiters.fetch(context as Parameters<typeof smartrecruiters.fetch>[0]))
      .rejects.toThrow(/refused by robots\.txt/);
  });
});
