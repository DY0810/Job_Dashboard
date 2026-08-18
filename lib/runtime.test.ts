import { describe, expect, it } from 'vitest';

import {
  BlockedAddressError,
  createRuntime,
  HttpError,
  isPrivateAddress,
  parseRobots,
  redact,
  RobotsDisallowedError,
  safeUrl,
  toEpochMs,
  TokenBucket,
  USER_AGENT,
} from './runtime.ts';

/** A fetch stub that records every URL it is asked for, in order, with a timestamp. */
function recorder(handler: (url: string) => Response | Promise<Response>) {
  const calls: { url: string; at: number }[] = [];
  const fetchImpl = async (url: string): Promise<Response> => {
    calls.push({ url, at: Date.now() });
    return handler(url);
  };
  return { calls, fetchImpl };
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers });

const ROBOTS_ALL = 'User-agent: *\nDisallow:\n';

describe('safeUrl / redact', () => {
  it('drops the query string, where every keyed source keeps its credential', () => {
    expect(safeUrl('https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=abc&app_key=s3cret')).toBe(
      'https://api.adzuna.com/v1/api/jobs/us/search/1',
    );
  });

  it('redacts credential-shaped params anywhere in a free-text message', () => {
    const line = redact('failed: https://x.test/a?app_key=s3cret&token=hunter2 (retrying)');
    expect(line).not.toContain('s3cret');
    expect(line).not.toContain('hunter2');
    expect(line).toContain('app_key=[redacted]');
  });

  it('does not impersonate a named crawler and carries a contact address', () => {
    expect(USER_AGENT).toMatch(/mailto:/);
    expect(USER_AGENT).not.toMatch(/claudebot|gptbot|googlebot/i);
  });
});

describe('TokenBucket', () => {
  it('spends its burst immediately, then enforces the gap', () => {
    const bucket = new TokenBucket(100, 2, 0);
    expect(bucket.reserve(0)).toBe(0);
    expect(bucket.reserve(0)).toBe(0);
    expect(bucket.reserve(0)).toBe(100);
  });

  it('refills over time', () => {
    const bucket = new TokenBucket(100, 1, 0);
    bucket.reserve(0);
    expect(bucket.reserve(100)).toBe(0);
  });
});

describe('rate limiter', () => {
  it('spaces two requests to the SAME host by at least the configured gap', async () => {
    const { calls, fetchImpl } = recorder(() => json({ ok: true }));
    const runtime = createRuntime({ fetchImpl, minGapMs: 120 });

    await runtime.fetchJson('https://one.test/a', { respectRobots: false });
    await runtime.fetchJson('https://one.test/b', { respectRobots: false });

    expect(calls).toHaveLength(2);
    expect(calls[1].at - calls[0].at).toBeGreaterThanOrEqual(115);
  });

  it('adds NO delay across different hosts', async () => {
    const { calls, fetchImpl } = recorder(() => json({ ok: true }));
    const runtime = createRuntime({ fetchImpl, minGapMs: 500 });

    const began = Date.now();
    await runtime.fetchJson('https://one.test/a', { respectRobots: false });
    await runtime.fetchJson('https://two.test/a', { respectRobots: false });
    await runtime.fetchJson('https://three.test/a', { respectRobots: false });

    expect(calls).toHaveLength(3);
    expect(Date.now() - began).toBeLessThan(400);
  });
});

describe('robots.txt', () => {
  const DISALLOW_JOBS = 'User-agent: *\nDisallow: /jobs\n';

  it('refuses a disallowed path BEFORE any network call to it', async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith('/robots.txt')
        ? new Response(DISALLOW_JOBS, { status: 200 })
        : json({ never: 'reached' }),
    );
    const runtime = createRuntime({ fetchImpl });

    await expect(runtime.fetchJson('https://board.test/jobs')).rejects.toBeInstanceOf(
      RobotsDisallowedError,
    );

    // Exactly one call, and it is robots.txt. The target was never contacted.
    expect(calls.map((call) => call.url)).toEqual(['https://board.test/robots.txt']);
  });

  it('allows a sibling path the same file does not disallow', async () => {
    const { fetchImpl } = recorder((url) =>
      url.endsWith('/robots.txt')
        ? new Response(DISALLOW_JOBS, { status: 200 })
        : json({ allowed: true }),
    );
    const runtime = createRuntime({ fetchImpl });
    await expect(runtime.fetchJson('https://board.test/api/postings')).resolves.toEqual({
      allowed: true,
    });
  });

  it('fetches robots.txt once per host and caches it', async () => {
    const { calls, fetchImpl } = recorder((url) =>
      url.endsWith('/robots.txt') ? new Response(ROBOTS_ALL, { status: 200 }) : json({ ok: 1 }),
    );
    const runtime = createRuntime({ fetchImpl, minGapMs: 0 });
    await runtime.fetchJson('https://board.test/a');
    await runtime.fetchJson('https://board.test/b');
    expect(calls.filter((call) => call.url.endsWith('/robots.txt'))).toHaveLength(1);
  });

  it('parses wildcards, $ anchors, longest-match-wins and crawl-delay', () => {
    const rules = parseRobots(
      ['User-agent: *', 'Disallow: /', 'Allow: /api/', 'Disallow: /api/private$', 'Crawl-delay: 2'].join(
        '\n',
      ),
    );
    expect(rules.isAllowed('/anything')).toBe(false);
    expect(rules.isAllowed('/api/jobs')).toBe(true);
    expect(rules.isAllowed('/api/private')).toBe(false);
    expect(rules.crawlDelayMs).toBe(2000);
  });

  it('uses the most specific matching group, so a rule aimed at another bot does not bind us', () => {
    const rules = parseRobots(
      ['User-agent: GPTBot', 'Disallow: /', 'User-agent: *', 'Allow: /'].join('\n'),
    );
    expect(rules.isAllowed('/api/jobs')).toBe(true);
  });

  it('matches the product token by longest PREFIX, not by substring or file order', () => {
    // `bot` is a substring of `workybot` but not a prefix — it must not capture our group,
    // and the answer must not depend on which group was declared first.
    const text = ['User-agent: bot', 'Disallow: /', 'User-agent: workybot', 'Allow: /'].join('\n');
    expect(parseRobots(text).isAllowed('/jobs')).toBe(true);
    const reordered = ['User-agent: workybot', 'Allow: /', 'User-agent: bot', 'Disallow: /'].join(
      '\n',
    );
    expect(parseRobots(reordered).isAllowed('/jobs')).toBe(true);
  });

  it('prefers the longest matching group when several are prefixes', () => {
    const text = ['User-agent: worky', 'Disallow: /', 'User-agent: workybot', 'Allow: /'].join('\n');
    expect(parseRobots(text).isAllowed('/jobs')).toBe(true);
  });

  it('treats an unreachable robots.txt as allow-all rather than zeroing out a run', async () => {
    const { fetchImpl } = recorder((url) => {
      if (url.endsWith('/robots.txt')) throw new Error('ECONNRESET');
      return json({ ok: true });
    });
    const runtime = createRuntime({ fetchImpl });
    await expect(runtime.fetchJson('https://board.test/jobs')).resolves.toEqual({ ok: true });
  });
});

describe('retry policy', () => {
  it('retries a 503 and succeeds', async () => {
    let attempts = 0;
    const runtime = createRuntime({
      minGapMs: 0,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) return new Response(ROBOTS_ALL, { status: 200 });
        attempts += 1;
        return attempts < 3 ? json({}, 503) : json({ recovered: true });
      },
    });
    await expect(runtime.fetchJson('https://flaky.test/jobs')).resolves.toEqual({ recovered: true });
    expect(attempts).toBe(3);
  });

  it('retries a 429 and honours Retry-After', async () => {
    const slept: number[] = [];
    let attempts = 0;
    const runtime = createRuntime({
      minGapMs: 0,
      sleep: async (ms) => {
        slept.push(ms);
      },
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) return new Response(ROBOTS_ALL, { status: 200 });
        attempts += 1;
        return attempts === 1 ? json({}, 429, { 'retry-after': '3' }) : json({ ok: true });
      },
    });
    await runtime.fetchJson('https://busy.test/jobs');
    expect(slept).toContain(3000);
  });

  it('NEVER retries a 4xx — a bad token is an answer, not a blip', async () => {
    let attempts = 0;
    const runtime = createRuntime({
      minGapMs: 0,
      sleep: async () => {},
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) return new Response(ROBOTS_ALL, { status: 200 });
        attempts += 1;
        return json({}, 404);
      },
    });
    await expect(runtime.fetchJson('https://gone.test/jobs')).rejects.toBeInstanceOf(HttpError);
    expect(attempts).toBe(1);
  });

  it('gives up after the retry budget and reports the status', async () => {
    const runtime = createRuntime({
      minGapMs: 0,
      retries: 2,
      sleep: async () => {},
      fetchImpl: async (url) =>
        url.endsWith('/robots.txt') ? new Response(ROBOTS_ALL, { status: 200 }) : json({}, 500),
    });
    await expect(runtime.fetchJson('https://down.test/jobs')).rejects.toThrow(/HTTP 500/);
  });
});

describe('timeout', () => {
  it('aborts a hanging request and says so without leaking the query string', async () => {
    const runtime = createRuntime({
      minGapMs: 0,
      fetchImpl: (url, init) =>
        url.endsWith('/robots.txt')
          ? Promise.resolve(new Response(ROBOTS_ALL, { status: 200 }))
          : new Promise((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
            }),
    });
    await expect(
      runtime.fetchJson('https://slow.test/jobs?app_key=s3cret', { timeoutMs: 40 }),
    ).rejects.toThrow(/timeout after 40ms/);
    await expect(
      runtime.fetchJson('https://slow.test/jobs?app_key=s3cret', { timeoutMs: 40 }),
    ).rejects.not.toThrow(/s3cret/);
  });

  it('uses redactUrl for sources that carry the key in the PATH', async () => {
    const runtime = createRuntime({
      minGapMs: 0,
      fetchImpl: async (url) =>
        url.endsWith('/robots.txt') ? new Response(ROBOTS_ALL, { status: 200 }) : json({}, 500),
      retries: 0,
    });
    await expect(
      runtime.fetchJson('https://jooble.test/api/SUPERSECRETKEY', {
        redactUrl: 'https://jooble.test/api/[key]',
      }),
    ).rejects.toThrow(/\[key\]/);
    await expect(
      runtime.fetchJson('https://jooble.test/api/SUPERSECRETKEY', {
        redactUrl: 'https://jooble.test/api/[key]',
      }),
    ).rejects.not.toThrow(/SUPERSECRETKEY/);
  });
});

describe('toEpochMs', () => {
  it('accepts every date shape the connectors actually see', () => {
    expect(toEpochMs(1770312903757)).toBe(1770312903757); // Lever, ms
    expect(toEpochMs(1786950859)).toBe(1786950859000); // RemoteOK/Arbeitnow, seconds
    expect(toEpochMs('2026-03-25T00:36:03.863+00:00')).toBe(Date.parse('2026-03-25T00:36:03.863Z'));
    expect(toEpochMs('2026-05-13 07:14:27 UTC')).toBe(Date.parse('2026-05-13T07:14:27Z')); // Recruitee
    expect(toEpochMs('2026-07-30')).toBe(Date.parse('2026-07-30')); // Workable
    expect(Number.isNaN(toEpochMs(undefined))).toBe(true);
    expect(Number.isNaN(toEpochMs('not a date'))).toBe(true);
  });
});

describe('publicOnly — the SSRF boundary for remotely-supplied URLs', () => {
  const publicDns = async () => ['93.184.216.34'];

  it('classifies the address space correctly', () => {
    for (const blocked of [
      '127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '172.31.255.255',
      '169.254.169.254', '0.0.0.0', '100.64.0.1', '198.18.0.1', '224.0.0.1',
      '::1', '::', 'fe80::1', 'fc00::1', '::ffff:127.0.0.1', '[::1]',
    ]) {
      expect(isPrivateAddress(blocked), blocked).toBe(true);
    }
    for (const allowed of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '192.169.0.1', '2606:2800::1']) {
      expect(isPrivateAddress(allowed), allowed).toBe(false);
    }
  });

  // The 192.0.x reservations are /24s, not /16s. A guard that ignores the third octet
  // blocks 65,536 addresses instead of 512 and silently reports live postings on ordinary
  // public 192.0.x hosts as unverifiable. Fails closed, so no test caught it by accident.
  it('treats 192.0.0.0/24 and 192.0.2.0/24 as reservations without swallowing 192.0.0.0/16', () => {
    for (const blocked of ['192.0.0.1', '192.0.0.255', '192.0.2.1', '192.0.2.254']) {
      expect(isPrivateAddress(blocked), blocked).toBe(true);
    }
    for (const allowed of ['192.0.1.1', '192.0.3.1', '192.0.100.1', '192.0.255.254']) {
      expect(isPrivateAddress(allowed), allowed).toBe(false);
    }
  });

  it('refuses a URL that resolves to a private address before any request goes out', async () => {
    let calls = 0;
    const runtime = createRuntime({
      fetchImpl: async () => {
        calls += 1;
        return new Response('ok', { status: 200 });
      },
      resolveHost: async () => ['127.0.0.1'],
      minGapMs: 0,
    });
    await expect(
      runtime.fetchText('http://internal.test/x', { publicOnly: true, respectRobots: false }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(calls).toBe(0);
  });

  it('judges an IPv6 literal rather than failing it as a DNS error', async () => {
    const runtime = createRuntime({
      fetchImpl: async () => new Response('x'),
      // dns.lookup is a no-op for a literal, so echo it back the way a resolver would.
      resolveHost: async (host) => [host],
      minGapMs: 0,
    });
    await expect(
      runtime.fetchText('http://[::1]:9200/x', { publicOnly: true, respectRobots: false }),
    ).rejects.toThrow(/non-public address/);
  });

  it('refuses a non-http scheme', async () => {
    const runtime = createRuntime({ fetchImpl: async () => new Response('x'), resolveHost: publicDns, minGapMs: 0 });
    await expect(
      runtime.fetchText('file:///etc/passwd', { publicOnly: true, respectRobots: false }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it('re-checks the destination on every redirect hop', async () => {
    // The actual attack: a public host the checker is willing to contact, which then bounces
    // it at loopback. `redirect: follow` would have made this request without a word.
    const seen: string[] = [];
    const runtime = createRuntime({
      fetchImpl: async (url) => {
        seen.push(url);
        return url.includes('evil.test')
          ? new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:9200/_all' } })
          : new Response('internal service', { status: 200 });
      },
      resolveHost: async (host) => (host === 'evil.test' ? ['93.184.216.34'] : ['127.0.0.1']),
      minGapMs: 0,
    });

    await expect(
      runtime.fetchText('http://evil.test/job/1', { publicOnly: true, respectRobots: false }),
    ).rejects.toBeInstanceOf(BlockedAddressError);
    expect(seen).toEqual(['http://evil.test/job/1']); // the loopback hop was never requested
  });

  it('follows a redirect that stays public, and caps the chain', async () => {
    let hops = 0;
    const runtime = createRuntime({
      fetchImpl: async () => {
        hops += 1;
        return hops <= 2
          ? new Response(null, { status: 302, headers: { location: `https://ok.test/${hops}` } })
          : new Response('landed', { status: 200 });
      },
      resolveHost: publicDns,
      minGapMs: 0,
    });
    expect(await runtime.fetchText('https://ok.test/start', { publicOnly: true, respectRobots: false })).toBe('landed');

    let endless = 0;
    const loop = createRuntime({
      fetchImpl: async () => {
        endless += 1;
        return new Response(null, { status: 302, headers: { location: `https://ok.test/${endless}` } });
      },
      resolveHost: publicDns,
      minGapMs: 0,
    });
    await expect(
      loop.fetchText('https://ok.test/start', { publicOnly: true, respectRobots: false }),
    ).rejects.toBeInstanceOf(HttpError);
    expect(endless).toBeLessThanOrEqual(6);
  });

  it('leaves the connectors alone: without publicOnly nothing resolves or is blocked', async () => {
    let resolved = 0;
    const runtime = createRuntime({
      fetchImpl: async () => new Response('body', { status: 200 }),
      resolveHost: async () => {
        resolved += 1;
        return ['127.0.0.1'];
      },
      minGapMs: 0,
    });
    expect(await runtime.fetchText('http://anything.test/x', { respectRobots: false })).toBe('body');
    expect(resolved).toBe(0);
  });
});

describe('publicOnly covers the robots.txt side-fetch', () => {
  /**
   * The subtle one: the request URL looks innocent, but the target host controls its own
   * /robots.txt, and the harness fetches that before anything else. Redirecting THAT at an
   * internal address reached it. Reproduced against real sockets before this was closed.
   */
  it('does not chase a redirected robots.txt, and does not disallow the request either', async () => {
    const seen: string[] = [];
    const runtime = createRuntime({
      fetchImpl: async (url, init) => {
        seen.push(`${(init?.redirect ?? 'follow') as string} ${url}`);
        return url.endsWith('/robots.txt')
          ? new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } })
          : new Response('the job page', { status: 200 });
      },
      resolveHost: async () => ['93.184.216.34'],
      minGapMs: 0,
    });

    expect(await runtime.fetchText('https://board.test/job/1', { publicOnly: true })).toBe('the job page');
    // The robots fetch must be the one that opts out of redirect following.
    expect(seen).toContain('manual https://board.test/robots.txt');
  });

  it('does not poison the shared robots cache for unguarded callers', async () => {
    let robotsRequests = 0;
    const runtime = createRuntime({
      fetchImpl: async (url) => {
        if (url.endsWith('/robots.txt')) {
          robotsRequests += 1;
          return robotsRequests === 1
            ? new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/' } })
            : new Response('User-agent: *\nDisallow: /job/', { status: 200 });
        }
        return new Response('body', { status: 200 });
      },
      resolveHost: async () => ['93.184.216.34'],
      minGapMs: 0,
    });

    // Guarded: the redirect is declined, so this caller gets ALLOW_ALL and proceeds.
    await runtime.fetchText('https://board.test/job/1', { publicOnly: true });
    // Unguarded: must re-read robots rather than inherit the guarded ALLOW_ALL.
    await expect(runtime.fetchText('https://board.test/job/1')).rejects.toBeInstanceOf(RobotsDisallowedError);
    expect(robotsRequests).toBe(2);
  });
});
