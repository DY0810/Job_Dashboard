import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { openDb, type Db } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import { createRuntime, type FetchLike } from '../lib/runtime.ts';
import {
  checkLink,
  classifyBody,
  formatSummary,
  parseAuditedIds,
  platformFor,
  runLinkcheck,
  type Verdict,
} from './linkcheck.ts';

function memoryDb(): Db {
  return openDb(':memory:', { migrate: true });
}

let nextKey = 0;

function seed(db: Db, url: string, track: 'design' | 'engineering' | null = 'design'): number {
  nextKey += 1;
  return db
    .insert(postings)
    .values({
      dedupeKey: `key-${nextKey}`,
      canonicalUrl: url,
      postedAt: new Date('2026-08-01T00:00:00Z'),
      firstSeenRun: 'test',
      company: 'Acme',
      title: 'Product Designer',
      companyNorm: 'acme',
      titleNorm: 'product designer',
      locationKey: 'remote',
      track,
    })
    .returning({ id: postings.id })
    .get().id;
}

/**
 * Bodies trimmed from what the live platforms actually served on 2026-08-18. The gone
 * greenhouse/ashby/workable pages below all answered **200** — which is the whole reason
 * this checker reads bodies (plans/workie.md finding H).
 */
const BODY = {
  greenhouseLive: '<html><head><title>Job Application for General Application at Speechmatics</title></head></html>',
  greenhouseGone: '<html><head><title>Jobs at Twilio</title></head><body>job-post job-post</body></html>',
  leverLive: '<html><head><title>Fantasy - Lead Product Designer</title></head><body><div data-qa="job-description">x</div></body></html>',
  ashbyLive: '<html><head><title>Researcher @ OpenAI</title><script>{"@type":"JobPosting"}</script></head></html>',
  ashbyGone: '<html><head><title>Jobs</title></head><body>window.__appData</body></html>',
  workableLive: '<html><head><title>Wild Card - Hugging Face</title><meta property="og:title" content="Wild Card - Hugging Face"></head></html>',
  workableGone: '<html><head><title>Workable</title><meta property="og:title" content="Current Openings"></head></html>',
  recruiteeLive: '<html><head><title>Nederland</title><script>{"@type": "JobPosting"}</script></head></html>',
};

const URL_FOR = {
  greenhouse: 'https://job-boards.greenhouse.io/twilio/jobs/8065040',
  greenhouseEu: 'https://job-boards.eu.greenhouse.io/speechmatics/jobs/4063763101',
  lever: 'https://jobs.lever.co/fantasy/423f0191',
  ashby: 'https://jobs.ashbyhq.com/openai/2560ed50',
  workable: 'https://apply.workable.com/j/0BD8C06DB3',
  recruitee: 'https://werkenbijsparkles.io/o/ervaren-developer',
};

/** `publicOnly` resolves the host, so the suite stubs DNS too — it must stay offline. */
const PUBLIC_DNS = async () => ['93.184.216.34'];

/** No network, no robots fetch, no waiting: the runtime is handed a canned responder. */
function runtimeWith(respond: (url: string, method: string) => { status: number; body: string }) {
  const fetchImpl: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
    const { status, body } = respond(url, method);
    return new Response(method === 'HEAD' ? null : body, { status });
  };
  return createRuntime({ fetchImpl, minGapMs: 0, sleep: async () => {}, resolveHost: PUBLIC_DNS });
}

describe('classifyBody', () => {
  it('reads a 200 gone-page as dead when the body identifies a closed destination', () => {
    expect(classifyBody(URL_FOR.greenhouse, BODY.greenhouseGone).verdict).toBe('dead');
    expect(classifyBody(URL_FOR.workable, BODY.workableGone).verdict).toBe('dead');
  });

  it('does not mistake an Ashby client-rendered shell for a closed job', () => {
    expect(classifyBody(URL_FOR.ashby, BODY.ashbyGone).verdict).toBe('unverifiable');
  });

  it('reads a real job page as live', () => {
    expect(classifyBody(URL_FOR.greenhouse, BODY.greenhouseLive).verdict).toBe('live');
    expect(classifyBody(URL_FOR.greenhouseEu, BODY.greenhouseLive).verdict).toBe('live');
    expect(classifyBody(URL_FOR.lever, BODY.leverLive).verdict).toBe('live');
    expect(classifyBody(URL_FOR.ashby, BODY.ashbyLive).verdict).toBe('live');
    // Recruitee runs on the customer's own domain, so it is recognised by its JSON-LD only.
    expect(classifyBody(URL_FOR.recruitee, BODY.recruiteeLive).verdict).toBe('live');
  });

  it('never assumes live: an unreadable 200 is unverifiable', () => {
    // Workable's live page carries no positive fingerprint, so it must NOT come back green.
    expect(classifyBody(URL_FOR.workable, BODY.workableLive).verdict).toBe('unverifiable');
    expect(classifyBody('https://example.test/jobs/1', '<html>hello</html>').verdict).toBe('unverifiable');
  });

  it('prefers the gone marker when a page carries both', () => {
    const both = `${BODY.greenhouseGone}<div class="application--form"></div>`;
    expect(classifyBody(URL_FOR.greenhouse, both).verdict).toBe('dead');
  });

  it('anchors host matching so a lookalike domain cannot claim a platform rule', () => {
    expect(platformFor('https://jobs.lever.co/x/1')?.name).toBe('lever');
    expect(platformFor('https://notlever.co/x/1')).toBeNull();
    expect(platformFor('https://evil-greenhouse.io/x/1')).toBeNull();
    expect(platformFor('not a url')).toBeNull();
  });
});

describe('checkLink', () => {
  const ashbyId = '723239cc-f90f-409d-86ec-3b02df603239';
  const ashbyUrl = `https://jobs.ashbyhq.com/cursor/${ashbyId}/application`;
  const anotherAshbyId = '123239cc-f90f-409d-86ec-3b02df603239';
  const listed = (id: string) => ({
    isListed: true,
    jobUrl: `https://jobs.ashbyhq.com/cursor/${id}`,
  });

  it('does not equate an API-listed Ashby role with a usable application page', async () => {
    const runtime = runtimeWith((url) => ({
      status: 200,
      body: url.includes('posting-api/job-board')
        ? JSON.stringify({ jobs: [listed(ashbyId)] })
        : BODY.ashbyGone,
    }));
    expect(await checkLink(runtime, { id: 1, url: ashbyUrl })).toMatchObject({
      verdict: 'unverifiable',
      reason: 'ashby: API lists role, application page unverified',
    });
  });

  it('requires absence from a valid Ashby board before marking its empty shell dead', async () => {
    const runtime = runtimeWith((url) => ({
      status: 200,
      body: url.includes('posting-api/job-board')
        ? JSON.stringify({ jobs: [listed(anotherAshbyId)] })
        : BODY.ashbyGone,
    }));
    expect(await checkLink(runtime, { id: 1, url: ashbyUrl })).toMatchObject({
      verdict: 'dead',
      reason: 'ashby: absent from official API',
    });
  });

  it.each([
    { status: 503, body: '{}' },
    { status: 200, body: '{}' },
    { status: 200, body: '{"jobs":[]}' },
    { status: 200, body: '{"jobs":[{}]}' },
    { status: 200, body: JSON.stringify({ jobs: [{ ...listed(ashbyId), isListed: false }] }) },
  ])('does not infer an Ashby closure from an unavailable or malformed board: %j', async (api) => {
    const runtime = runtimeWith((url) => url.includes('posting-api/job-board')
      ? api
      : { status: 200, body: BODY.ashbyGone });
    expect((await checkLink(runtime, { id: 1, url: ashbyUrl })).verdict).toBe('unverifiable');
  });

  it('fetches each Ashby board only once for concurrent link checks', async () => {
    let apiCalls = 0;
    const runtime = runtimeWith((url) => {
      if (url.includes('posting-api/job-board')) {
        apiCalls += 1;
        return { status: 200, body: JSON.stringify({ jobs: [listed(ashbyId), listed(anotherAshbyId)] }) };
      }
      return { status: 200, body: BODY.ashbyGone };
    });
    const results = await Promise.all([ashbyId, anotherAshbyId].map((id, index) =>
      checkLink(runtime, { id: index, url: `https://jobs.ashbyhq.com/cursor/${id}/application` })));
    expect(results.map((result) => result.verdict)).toEqual(['unverifiable', 'unverifiable']);
    expect(apiCalls).toBe(1);
  });

  it('reports a 404 as dead without downloading the body', async () => {
    let gets = 0;
    const runtime = runtimeWith((_url, method) => {
      if (method === 'GET') gets += 1;
      return { status: 404, body: 'gone' };
    });
    const result = await checkLink(runtime, { id: 1, url: URL_FOR.lever });
    expect(result).toMatchObject({ verdict: 'dead', status: 404, reason: 'HTTP 404' });
    expect(gets).toBe(0);
  });

  it('catches the 200-but-gone case a HEAD-only checker would call green', async () => {
    const runtime = runtimeWith(() => ({ status: 200, body: BODY.greenhouseGone }));
    const result = await checkLink(runtime, { id: 1, url: URL_FOR.greenhouse });
    expect(result.status).toBe(200);
    expect(result.verdict).toBe('dead');
  });

  it('falls back to GET when a host refuses HEAD', async () => {
    const runtime = runtimeWith((_url, method) =>
      method === 'HEAD' ? { status: 405, body: '' } : { status: 200, body: BODY.ashbyLive },
    );
    expect((await checkLink(runtime, { id: 1, url: URL_FOR.ashby })).verdict).toBe('live');
  });

  it('treats a network failure as unverifiable, never as dead', async () => {
    const runtime = createRuntime({
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) return new Response('', { status: 404 });
        throw new Error('ECONNRESET');
      },
      minGapMs: 0,
      sleep: async () => {},
      resolveHost: PUBLIC_DNS,
    });
    const result = await checkLink(runtime, { id: 1, url: URL_FOR.ashby });
    expect(result.verdict).toBe('unverifiable');
    expect(result.status).toBeNull();
  });

  it('reports an explicit robots denial as unverifiable without requesting the posting', async () => {
    let targetRequests = 0;
    const runtime = createRuntime({
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) return new Response('User-agent: *\nDisallow: /\n', { status: 200 });
        targetRequests += 1;
        return new Response(BODY.ashbyLive, { status: 200 });
      },
      minGapMs: 0,
      sleep: async () => {},
      resolveHost: PUBLIC_DNS,
    });

    const result = await checkLink(runtime, { id: 1, url: URL_FOR.ashby });

    expect(result).toMatchObject({
      verdict: 'unverifiable',
      status: null,
      reason: 'robots.txt disallows checking it',
    });
    expect(targetRequests).toBe(0);
  });
});

describe('runLinkcheck', () => {
  it('reports every dead link with its posting id and marks it delisted', async () => {
    const db = memoryDb();
    const liveId = seed(db, URL_FOR.ashby);
    const deadId = seed(db, URL_FOR.lever);

    const runtime = runtimeWith((url) =>
      url === URL_FOR.lever ? { status: 404, body: '' } : { status: 200, body: BODY.ashbyLive },
    );
    const logged: Record<string, unknown>[] = [];
    const summary = await runLinkcheck(db, runtime, { log: (record) => logged.push(record) });

    expect(summary).toMatchObject({ checked: 2, live: 1, dead: 1, unverifiable: 0, marked: 1 });
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({ posting: deadId, verdict: 'dead', status: 404 });

    const rows = db.select().from(postings).all();
    expect(rows.find((row) => row.id === deadId)!.delistedAt).not.toBeNull();
    expect(rows.find((row) => row.id === liveId)!.delistedAt).toBeNull();
  });

  it('reports an unverifiable link but does not delist it', async () => {
    const db = memoryDb();
    const id = seed(db, URL_FOR.workable);
    const runtime = runtimeWith(() => ({ status: 200, body: BODY.workableLive }));
    const logged: Record<string, unknown>[] = [];
    const summary = await runLinkcheck(db, runtime, { log: (record) => logged.push(record) });

    expect(summary).toMatchObject({ dead: 0, unverifiable: 1, marked: 0 });
    expect(logged[0]).toMatchObject({ posting: id, verdict: 'unverifiable' });
    expect(db.select().from(postings).get()!.delistedAt).toBeNull();
  });

  it('--dry-run reports without writing', async () => {
    const db = memoryDb();
    seed(db, URL_FOR.lever);
    const runtime = runtimeWith(() => ({ status: 410, body: '' }));
    const summary = await runLinkcheck(db, runtime, { dryRun: true, log: () => {} });

    expect(summary).toMatchObject({ dead: 1, marked: 0 });
    expect(db.select().from(postings).get()!.delistedAt).toBeNull();
  });

  it('never logs a URL with its query string', async () => {
    const db = memoryDb();
    seed(db, 'https://example.test/jobs/1?token=supersecret');
    const runtime = runtimeWith(() => ({ status: 404, body: '' }));
    const logged: Record<string, unknown>[] = [];
    await runLinkcheck(db, runtime, { log: (record) => logged.push(record) });

    expect(JSON.stringify(logged)).not.toContain('supersecret');
  });

  it('rejects invalid concurrency instead of silently reporting an empty run', async () => {
    const db = memoryDb();
    seed(db, URL_FOR.lever);

    await expect(runLinkcheck(db, runtimeWith(() => ({ status: 404, body: '' })), { concurrency: 0 })).rejects.toThrow(
      'concurrency must be a positive integer',
    );
  });

  it('checks only selected IDs and validates unknown IDs before any write', async () => {
    const db = memoryDb();
    const checked = seed(db, URL_FOR.lever);
    const untouched = seed(db, URL_FOR.ashby);
    const dropped = seed(db, URL_FOR.workable, null);
    const runtime = runtimeWith((url) =>
      url === URL_FOR.lever ? { status: 404, body: '' } : { status: 200, body: BODY.ashbyLive },
    );

    const summary = await runLinkcheck(db, runtime, { ids: [checked], log: () => {} });
    expect(summary).toMatchObject({ checked: 1, dead: 1, marked: 1 });
    expect(db.select().from(postings).where(eq(postings.id, checked)).get()!.delistedAt).not.toBeNull();
    expect(db.select().from(postings).where(eq(postings.id, untouched)).get()!.delistedAt).toBeNull();

    await expect(runLinkcheck(db, runtime, { ids: [untouched, 9_999_999], log: () => {} })).rejects.toThrow(
      'unknown posting ids: 9999999',
    );
    await expect(runLinkcheck(db, runtime, { ids: [dropped], log: () => {} })).rejects.toThrow(
      `posting ids are not currently checkable: ${dropped}`,
    );
    expect(db.select().from(postings).where(eq(postings.id, untouched)).get()!.delistedAt).toBeNull();
  });

  it('rechecks and restores only a linkcheck-delisted selected ID after a verified-live result', async () => {
    const db = memoryDb();
    const linkcheckId = seed(db, URL_FOR.ashby);
    const ghostId = seed(db, URL_FOR.lever);
    const markedAt = new Date('2026-08-20T00:00:00Z');
    db.update(postings)
      .set({ delistedAt: markedAt, delistedReason: 'linkcheck' })
      .where(eq(postings.id, linkcheckId))
      .run();
    db.update(postings)
      .set({ delistedAt: markedAt, delistedReason: 'ghost' })
      .where(eq(postings.id, ghostId))
      .run();

    const summary = await runLinkcheck(db, runtimeWith(() => ({ status: 200, body: BODY.ashbyLive })), {
      ids: [linkcheckId],
      log: () => {},
    });

    expect(summary).toMatchObject({ checked: 1, live: 1, marked: 0, restored: 1 });
    expect(db.select().from(postings).where(eq(postings.id, linkcheckId)).get()).toMatchObject({
      delistedAt: null,
      delistedReason: null,
    });
    expect(db.select().from(postings).where(eq(postings.id, ghostId)).get()).toMatchObject({
      delistedAt: markedAt,
      delistedReason: 'ghost',
    });
    await expect(runLinkcheck(db, runtimeWith(() => ({ status: 200, body: BODY.leverLive })), {
      ids: [ghostId],
      log: () => {},
    })).rejects.toThrow(`posting ids are not currently checkable: ${ghostId}`);
  });

  it('does not rewrite an existing linkcheck-delisted timestamp when it remains dead', async () => {
    const db = memoryDb();
    const id = seed(db, URL_FOR.lever);
    const markedAt = new Date('2026-08-20T00:00:00Z');
    db.update(postings)
      .set({ delistedAt: markedAt, delistedReason: 'linkcheck' })
      .where(eq(postings.id, id))
      .run();

    const summary = await runLinkcheck(db, runtimeWith(() => ({ status: 404, body: '' })), {
      ids: [id],
      log: () => {},
    });

    expect(summary).toMatchObject({ checked: 1, dead: 1, marked: 0, restored: 0 });
    expect(db.select().from(postings).where(eq(postings.id, id)).get()).toMatchObject({
      delistedAt: markedAt,
      delistedReason: 'linkcheck',
    });
  });
});

describe('parseAuditedIds', () => {
  it('accepts positive, unique decimal IDs only', () => {
    expect(parseAuditedIds('1,42,2147483647')).toEqual([1, 42, 2_147_483_647]);
  });

  it.each(['', '0', '01', '1,', ',1', '1, 2', '1,1', '2147483648', 'x'])('rejects %j', (raw) => {
    expect(() => parseAuditedIds(raw)).toThrow('bad --ids');
  });
});

describe('formatSummary', () => {
  it('reports restored rows', () => {
    expect(
      formatSummary(
        { checked: 1, live: 1, dead: 0, unverifiable: 0, marked: 0, restored: 1, results: [] },
        false,
      ),
    ).toContain('1 restored');
  });
});

describe('the SSRF boundary, from the checker down', () => {
  it('refuses a stored canonical_url that points into the private network', async () => {
    const db = memoryDb();
    const id = seed(db, 'http://169.254.169.254/latest/meta-data/');
    let requests = 0;
    const runtime = createRuntime({
      fetchImpl: async () => {
        requests += 1;
        return new Response('creds', { status: 200 });
      },
      resolveHost: async () => ['169.254.169.254'],
      minGapMs: 0,
      sleep: async () => {},
    });

    const logged: Record<string, unknown>[] = [];
    const summary = await runLinkcheck(db, runtime, { log: (record) => logged.push(record) });

    expect(requests).toBe(0);
    // Blocked is not the same claim as gone: it is reported, and it does not delist.
    expect(summary).toMatchObject({ dead: 0, unverifiable: 1, marked: 0 });
    expect(logged[0]).toMatchObject({ posting: id, verdict: 'unverifiable' });
    expect(String(logged[0].reason)).toContain('non-public address');
  });
});

describe('a bad status is not automatically a dead posting', () => {
  const cases: [number, Verdict][] = [
    [404, 'dead'],
    [410, 'dead'],
    // Found in a real 500-link run: HN rate-limits, Epic Games blocks bots. Neither is gone,
    // and calling them dead would have delisted thirteen live postings.
    [429, 'unverifiable'],
    [403, 'unverifiable'],
    [401, 'unverifiable'],
    [500, 'unverifiable'],
    [503, 'unverifiable'],
  ];

  for (const [status, expected] of cases) {
    it(`reads HTTP ${status} as ${expected}`, async () => {
      const runtime = runtimeWith(() => ({ status, body: 'whatever' }));
      const result = await checkLink(runtime, { id: 1, url: URL_FOR.lever });
      expect(result).toMatchObject({ status, verdict: expected });
    });
  }

  it('does not delist a rate-limited posting', async () => {
    const db = memoryDb();
    seed(db, URL_FOR.lever);
    const summary = await runLinkcheck(db, runtimeWith(() => ({ status: 429, body: '' })), { log: () => {} });
    expect(summary).toMatchObject({ dead: 0, unverifiable: 1, marked: 0 });
    expect(db.select().from(postings).get()!.delistedAt).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Why the weekly run had never committed anything: 153 HN canonical URLs on one host that
// answers 429 behind a 30s crawl-delay burned ~76 of the 90 budgeted minutes for verdicts
// that carry no signal (a thread item does not 404 when the job dies), the alarm killed
// the run, and the single end-of-run transaction meant zero delistings — forever, while
// looking installed. Same run: the corpus tripled, but apply links only exist on visible
// rows, so the check's scope is visible rows.
// ---------------------------------------------------------------------------------------

describe('the run fits its budget', () => {
  it('never fetches a no-signal host, and reports it unverifiable', async () => {
    const db = memoryDb();
    const id = seed(db, 'https://news.ycombinator.com/item?id=41234567');
    const fetched: string[] = [];
    const runtime = runtimeWith((url) => {
      fetched.push(url);
      return { status: 429, body: '' };
    });
    const logged: Record<string, unknown>[] = [];
    const summary = await runLinkcheck(db, runtime, { log: (record) => logged.push(record) });

    expect(fetched).toHaveLength(0);
    expect(summary).toMatchObject({ checked: 1, unverifiable: 1, dead: 0, marked: 0 });
    expect(logged[0]).toMatchObject({ posting: id, verdict: 'unverifiable' });
  });

  it('checks only visible rows — a dropped posting has no apply button to verify', async () => {
    const db = memoryDb();
    seed(db, URL_FOR.ashby, null); // track null: extraction dropped it, no tab renders it
    const visible = seed(db, URL_FOR.lever, 'engineering');
    const fetched: string[] = [];
    const runtime = runtimeWith((url) => {
      fetched.push(url);
      return { status: 200, body: BODY.ashbyLive };
    });
    const summary = await runLinkcheck(db, runtime, { log: () => {} });

    expect(summary.checked).toBe(1);
    expect(fetched.some((u) => u === URL_FOR.lever)).toBe(true);
    expect(fetched.some((u) => u === URL_FOR.ashby)).toBe(false);
    void visible;
  });
});
