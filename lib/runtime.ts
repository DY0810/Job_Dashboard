/**
 * The shared connector harness (plan Phase 2).
 *
 * Everything that touches the network goes through here: one timeout policy, one retry
 * policy, one rate limiter, one robots.txt cache, one User-Agent. Connectors contain
 * response-shape knowledge and nothing else.
 *
 * `createRuntime()` returns an instance rather than exporting module-level functions so the
 * robots cache and the per-host buckets are scoped to a run — tests get a clean one for free
 * and can inject `fetchImpl` to assert on timing and on refusals without a network call.
 */

import { lookup } from 'node:dns/promises';

import type { RawPosting, SourceKind } from './dedupe.ts';

/** Descriptive, with a contact address, per the plan. Must not impersonate a named crawler. */
export const USER_AGENT =
  'WorkyBot/0.1 (+mailto:dongyeop0810@gmail.com; personal job-search dashboard; contact before blocking)';

/** The product token robots.txt groups are matched against. */
const UA_TOKEN = 'workybot';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface FetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** Abort after this many ms. Counts the whole response, not just the headers. */
  timeoutMs?: number;
  /** Retries on 429/5xx only. 0 disables. */
  retries?: number;
  /** Consult robots.txt first. Default true; opt out only for documented public APIs. */
  respectRobots?: boolean;
  /**
   * What to show instead of this URL in logs and errors. Jooble puts its API key in the
   * PATH, where `safeUrl` cannot strip it — such a source must pass a scrubbed string here.
   */
  redactUrl?: string;
  /**
   * Refuse to contact anything but a public http(s) address, re-checking every redirect hop.
   *
   * Every connector calls a hardcoded API host, so this is off by default. `linkcheck` is the
   * one caller that fetches a URL which arrived as remote data (`postings.canonical_url`, put
   * there by whatever a job board said), and that is a genuine SSRF boundary: without this, a
   * hostile listing whose apply URL 302s to `http://127.0.0.1:9200/` gets that request made.
   */
  publicOnly?: boolean;
}

export interface RuntimeOptions {
  fetchImpl?: FetchLike;
  /** Minimum ms between two requests to one host (a burst-1 token bucket). */
  minGapMs?: number;
  /** How many requests may go out back-to-back before the gap applies. */
  burst?: number;
  timeoutMs?: number;
  retries?: number;
  robotsTtlMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Name resolution for the `publicOnly` check. Injected by tests; DNS otherwise. */
  resolveHost?: (host: string) => Promise<string[]>;
}

export interface Runtime {
  fetchText(url: string, options?: FetchOptions): Promise<string>;
  fetchJson<T>(url: string, options?: FetchOptions): Promise<T>;
  isAllowed(url: string): Promise<boolean>;
}

/** Carries a status so the retry policy and the connectors can branch without string tests. */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpError';
    this.status = status;
  }
}

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt disallows ${url}`);
    this.name = 'RobotsDisallowedError';
  }
}

/** A `publicOnly` request that resolved to a scheme or an address we refuse to contact. */
export class BlockedAddressError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'BlockedAddressError';
  }
}

// ---------------------------------------------------------------------------------------
// Destination policy (SSRF)
// ---------------------------------------------------------------------------------------

/** Redirect statuses that carry a `Location` we would otherwise follow blindly. */
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

/**
 * Everything that is not routable public internet: loopback, RFC1918, link-local (which
 * includes the 169.254.169.254 cloud metadata endpoint), CGNAT, benchmarking, multicast and
 * reserved space, in both address families.
 */
export function isPrivateAddress(address: string): boolean {
  const plain = address.replace(/^\[|\]$/g, '').replace(/%.*$/, '');

  // ::ffff:10.0.0.1 is an IPv4 address wearing an IPv6 hat; judge the address it carries.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(plain);
  const candidate = mapped ? mapped[1] : plain;

  if (/^\d+\.\d+\.\d+\.\d+$/.test(candidate)) {
    const [a, b, c] = candidate.split('.').map(Number);
    if ([a, b, c].some((part) => !Number.isInteger(part) || part > 255)) return true;
    return (
      a === 0 || // "this network"
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) || // link-local, incl. the cloud metadata address
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) || // 192.0.0.0/24 IETF protocol assignments
      (a === 192 && b === 0 && c === 2) || // 192.0.2.0/24 TEST-NET-1, also not routable
      (a === 100 && b >= 64 && b <= 127) || // CGNAT
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      a >= 224 // multicast and reserved
    );
  }

  const v6 = candidate.toLowerCase();
  if (v6 === '::' || v6 === '::1') return true;
  return /^f[cd]/.test(v6) /* unique-local fc00::/7 */ || /^fe[89ab]/.test(v6) /* link-local */;
}

/**
 * ponytail: resolves the name and checks the answer, which leaves a DNS-rebinding window
 * between this lookup and the socket the fetch opens. Closing that needs a dispatcher with a
 * connect-time hook (undici), which is not a dependency here. For a locally-run checker this
 * stops the real attack — a hostile listing redirecting at internal services — and the
 * residual race needs an attacker who already controls a DNS server.
 */
async function assertPublicDestination(
  target: string,
  label: string,
  resolve: (host: string) => Promise<string[]>,
): Promise<void> {
  const parsed = new URL(target);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new BlockedAddressError(`refusing scheme ${parsed.protocol} for ${label}`);
  }
  // `hostname` keeps the brackets on an IPv6 literal (`http://[::1]/`), which no resolver
  // accepts. Stripping them means such a URL is judged rather than failing as a DNS error.
  const addresses = await resolve(parsed.hostname.replace(/^\[|\]$/g, ''));
  if (addresses.length === 0) throw new BlockedAddressError(`${label} does not resolve`);
  if (addresses.some(isPrivateAddress)) {
    throw new BlockedAddressError(`${label} resolves to a non-public address`);
  }
}

/**
 * A URL safe to put in a log line or an error: origin + path, never the query string.
 *
 * Adzuna, Careerjet and Jooble all carry their credential in the query, so "log the URL that
 * failed" is exactly how a key ends up in a log file. Dropping the query outright is one line
 * and cannot be got wrong later by adding a new keyed source.
 */
export function safeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return '[unparseable url]';
  }
}

/** Second line of defence for strings we did not build ourselves (e.g. a thrown message). */
const SECRET_PARAM = /\b(app_?id|app_?key|api[-_]?key|key|token|affid|secret|password)=([^&\s"']+)/gi;

export function redact(message: string): string {
  return message.replace(SECRET_PARAM, (_m, name: string) => `${name}=[redacted]`);
}

// ---------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------

/**
 * Per-host token bucket. `burst` tokens refill at one per `gapMs`; `reserve` hands back how
 * long the caller must wait and books the slot synchronously, so two concurrent callers
 * cannot be handed the same one.
 */
export class TokenBucket {
  gapMs: number;

  private readonly burst: number;
  private tokens: number;
  private last: number;

  constructor(gapMs: number, burst: number, now: number) {
    this.gapMs = gapMs;
    this.burst = burst;
    this.tokens = burst;
    this.last = now;
  }

  reserve(now: number): number {
    this.tokens = Math.min(this.burst, this.tokens + (now - this.last) / this.gapMs);
    this.last = now;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return 0;
    }
    const wait = Math.ceil((1 - this.tokens) * this.gapMs);
    this.tokens = 0;
    this.last = now + wait;
    return wait;
  }
}

// ---------------------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------------------

export interface RobotsRules {
  isAllowed(path: string): boolean;
  crawlDelayMs: number;
}

const ALLOW_ALL: RobotsRules = { isAllowed: () => true, crawlDelayMs: 0 };

interface Rule {
  allow: boolean;
  pattern: RegExp;
  /** RFC 9309: the longest matching rule wins, Allow breaks a tie. */
  length: number;
}

function rulePattern(path: string): RegExp {
  // The trailing `$` is robots.txt's end-of-path anchor, so it has to be recognised BEFORE
  // the escape pass turns it into a literal dollar sign.
  const anchored = path.endsWith('$');
  const escaped = (anchored ? path.slice(0, -1) : path).replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped.replace(/\*/g, '.*')}${anchored ? '$' : ''}`);
}

/**
 * Parse robots.txt for one user-agent. Supports `*` and `$` wildcards, `Crawl-delay`, and
 * longest-match-wins between Allow and Disallow (RFC 9309 §2.2.2).
 *
 * Only the most specific matching group is used: an exact user-agent group beats `*`, which
 * is why a file that blocks `GPTBot` but allows `*` stays open to us.
 */
export function parseRobots(text: string, uaToken: string = UA_TOKEN): RobotsRules {
  const groups = new Map<string, { rules: Rule[]; crawlDelay: number }>();
  let current: string[] = [];
  let sawRule = false;

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (sawRule) {
        current = [];
        sawRule = false;
      }
      current.push(value.toLowerCase());
      if (!groups.has(value.toLowerCase())) groups.set(value.toLowerCase(), { rules: [], crawlDelay: 0 });
      continue;
    }
    if (current.length === 0) continue;

    if (field === 'allow' || field === 'disallow') {
      sawRule = true;
      // "Disallow:" with an empty value means "nothing is disallowed" — not a rule.
      if (field === 'disallow' && value === '') continue;
      if (value === '') continue;
      const rule: Rule = { allow: field === 'allow', pattern: rulePattern(value), length: value.length };
      for (const agent of current) groups.get(agent)!.rules.push(rule);
    } else if (field === 'crawl-delay') {
      sawRule = true;
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds > 0) {
        for (const agent of current) groups.get(agent)!.crawlDelay = seconds;
      }
    }
  }

  // RFC 9309 §2.2.1: match the product token by prefix, and when several groups match, the
  // longest one wins. `includes` would let a group named `bot` capture `workybot`, and
  // picking the first match would make the answer depend on the order lines appear in.
  const exact = [...groups.keys()]
    .filter((agent) => agent !== '*' && uaToken.startsWith(agent))
    .sort((a, b) => b.length - a.length)[0];
  const group = groups.get(exact ?? '*');
  if (!group) return ALLOW_ALL;

  return {
    crawlDelayMs: group.crawlDelay * 1000,
    isAllowed(path: string): boolean {
      let best: Rule | undefined;
      for (const rule of group.rules) {
        if (!rule.pattern.test(path)) continue;
        if (!best || rule.length > best.length || (rule.length === best.length && rule.allow)) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}

// ---------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------

const DEFAULTS = {
  minGapMs: 500,
  burst: 1,
  timeoutMs: 20_000,
  retries: 3,
  robotsTtlMs: 24 * 60 * 60 * 1000,
} as const;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createRuntime(options: RuntimeOptions = {}): Runtime {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const minGapMs = options.minGapMs ?? DEFAULTS.minGapMs;
  const burst = options.burst ?? DEFAULTS.burst;
  const robotsTtlMs = options.robotsTtlMs ?? DEFAULTS.robotsTtlMs;
  const defaultTimeoutMs = options.timeoutMs ?? DEFAULTS.timeoutMs;
  const defaultRetries = options.retries ?? DEFAULTS.retries;
  const resolveHost =
    options.resolveHost ??
    (async (host: string) => (await lookup(host, { all: true })).map((entry) => entry.address));

  const buckets = new Map<string, TokenBucket>();
  const robotsCache = new Map<string, { rules: Promise<RobotsRules>; expiresAt: number }>();

  function bucketFor(host: string, gapMs: number): TokenBucket {
    const existing = buckets.get(host);
    if (existing) {
      // A host that publishes a Crawl-delay only slows us down, never speeds us up.
      existing.gapMs = Math.max(existing.gapMs, gapMs);
      return existing;
    }
    const bucket = new TokenBucket(gapMs, burst, now());
    buckets.set(host, bucket);
    return bucket;
  }

  async function throttle(host: string, gapMs: number): Promise<void> {
    const wait = bucketFor(host, gapMs).reserve(now());
    if (wait > 0) await sleep(wait);
  }

  /**
   * `guarded` is the `publicOnly` caller's robots fetch, and it is its own SSRF surface: the
   * target host controls its own /robots.txt, so redirecting THAT at an internal address
   * reaches it without the request URL ever looking suspicious. Verified reachable before
   * this branch existed. Under `guarded` the redirect is not followed at all — a robots.txt
   * we decline to chase is treated exactly like an unreachable one.
   */
  async function loadRobots(origin: string, guarded: boolean): Promise<RobotsRules> {
    // Not rate-limited and not retried: one request per host per day, and a slow robots.txt
    // must not be able to stall a whole connector.
    try {
      const init: RequestInit = guarded ? { redirect: 'manual' } : {};
      const response = await withTimeout(`${origin}/robots.txt`, init, defaultTimeoutMs);
      if (guarded && REDIRECT_STATUS.has(response.status)) return ALLOW_ALL;
      if (!response.ok) return ALLOW_ALL;
      return parseRobots(await response.text());
    } catch {
      // ponytail: fail OPEN on an unreachable robots.txt. RFC 9309 says treat a 5xx as a
      // full disallow; here that would let one flaky minute silently zero out a run, and we
      // only ever call documented endpoints. Revisit if a Tier-3 scraper phase lands.
      return ALLOW_ALL;
    }
  }

  function robotsFor(origin: string, guarded: boolean): Promise<RobotsRules> {
    // Keyed on `guarded` too: a guarded load can end in ALLOW_ALL for a reason that says
    // nothing about the host's actual rules, and that answer must not be served to a
    // connector asking the same question without the guard.
    const key = guarded ? `guarded ${origin}` : origin;
    const cached = robotsCache.get(key);
    if (cached && cached.expiresAt > now()) return cached.rules;
    const rules = loadRobots(origin, guarded);
    robotsCache.set(key, { rules, expiresAt: now() + robotsTtlMs });
    return rules;
  }

  async function withTimeout(
    url: string,
    init: RequestInit,
    timeoutMs: number,
    label: string = safeUrl(url),
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetchImpl(url, {
        ...init,
        headers: { 'User-Agent': USER_AGENT, Accept: '*/*', ...init.headers },
        signal: controller.signal,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(
        controller.signal.aborted
          ? `timeout after ${timeoutMs}ms for ${label}`
          : `${redact(reason)} for ${label}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function isAllowed(url: string): Promise<boolean> {
    const parsed = new URL(url);
    const rules = await robotsFor(parsed.origin, false);
    return rules.isAllowed(parsed.pathname + parsed.search);
  }

  async function fetchText(url: string, options: FetchOptions = {}): Promise<string> {
    const parsed = new URL(url);
    const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    const retries = options.retries ?? defaultRetries;
    const label = options.redactUrl ?? safeUrl(url);

    // Before ANYTHING is contacted — the robots.txt fetch below is itself a request to this
    // host, so checking the destination after it would leave the SSRF hole wide open.
    if (options.publicOnly) await assertPublicDestination(url, label, resolveHost);

    let crawlDelayMs = 0;
    if (options.respectRobots !== false) {
      const rules = await robotsFor(parsed.origin, options.publicOnly === true);
      // Refused BEFORE the target is ever contacted.
      if (!rules.isAllowed(parsed.pathname + parsed.search)) throw new RobotsDisallowedError(label);
      crawlDelayMs = rules.crawlDelayMs;
    }

    const init: RequestInit = {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      // `publicOnly` has to see each hop: following redirects inside fetch would hand a
      // hostile board a one-line bypass of the destination check.
      redirect: options.publicOnly ? 'manual' : 'follow',
    };

    let target = url;
    let redirects = 0;

    for (let attempt = 0; ; ) {
      await throttle(new URL(target).host, Math.max(minGapMs, crawlDelayMs));
      const response = await withTimeout(target, init, timeoutMs, label);
      if (response.ok) return response.text();

      if (options.publicOnly && REDIRECT_STATUS.has(response.status)) {
        const location = response.headers.get('location');
        // A redirect we cannot or will not follow is reported as itself, not as a success.
        if (location === null || redirects >= MAX_REDIRECTS) throw new HttpError(response.status, label);
        redirects += 1;
        target = new URL(location, target).toString();
        // Each hop is a destination the remote side chose, so each hop is re-checked.
        await assertPublicDestination(target, label, resolveHost);
        // ponytail: a hop keeps the original method and the origin host's Crawl-delay, and
        // does not re-read robots.txt for a new origin. `linkcheck` only ever sends HEAD/GET
        // to a URL a board published as its own apply link, so none of the three bites; a
        // future publicOnly caller that POSTs or crawls across origins would need them.
        continue; // a hop is not a retry attempt
      }

      // Retry 429 and 5xx ONLY. A 4xx is an answer, not a blip — retrying it is how a bad
      // token turns into four bad tokens.
      const retryable = response.status === 429 || response.status >= 500;
      if (!retryable || attempt >= retries) throw new HttpError(response.status, label);

      const retryAfter = Number.parseFloat(response.headers.get('retry-after') ?? '');
      const backoff = Number.isFinite(retryAfter)
        ? retryAfter * 1000
        : 2 ** attempt * 500 + Math.random() * 500; // jittered exponential
      attempt += 1;
      await sleep(backoff);
    }
  }

  async function fetchJson<T>(url: string, options: FetchOptions = {}): Promise<T> {
    const text = await fetchText(url, options);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`non-JSON response from ${options.redactUrl ?? safeUrl(url)}`);
    }
  }

  return { fetchText, fetchJson, isAllowed };
}

// ---------------------------------------------------------------------------------------
// The connector contract
// ---------------------------------------------------------------------------------------

/** What every connector returns. `description` is already through `normalizeDescription`. */
export interface ConnectorPosting extends RawPosting {
  description: string;
}

export interface ConnectorContext {
  runtime: Runtime;
  env: Record<string, string | undefined>;
  /** One structured JSON line. Never pass a raw URL with a query string. */
  log(record: Record<string, unknown>): void;
}

export interface Connector {
  name: string;
  kind: SourceKind;
  /**
   * Return a human-readable reason to skip this run, or null to run. A missing API key is a
   * skip, not an error: it writes no `connector_runs` row, so ghost detection cannot read
   * the absence as "this source dropped its postings" (finding C).
   */
  skip?(env: Record<string, string | undefined>): string | null;
  fetch(context: ConnectorContext): Promise<ConnectorPosting[]>;
}

/** Epoch ms from whatever shape a source felt like using; NaN when it is unusable. */
export function toEpochMs(value: unknown): number {
  if (typeof value === 'number') return value > 1e11 ? value : value * 1000;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && /^\d+$/.test(value.trim())) {
    return numeric > 1e11 ? numeric : numeric * 1000;
  }
  // "2026-05-13 07:14:27 UTC" (Recruitee) is not ISO; Date.parse handles it once the marker
  // is turned into an offset.
  const parsed = Date.parse(value.replace(/\s+UTC$/i, 'Z').replace(/^(\d{4}-\d{2}-\d{2}) /, '$1T'));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}
