// Shared probing primitives for scripts/resolve-companies.ts and scripts/refresh-registry.ts.
//
// Plain JS (not .ts) on purpose: Node's native TS type-stripping requires relative imports
// to carry the literal ".ts" extension, which tsc then rejects (TS5097) under this repo's
// tsconfig (no `allowImportingTsExtensions`, and that file is out of scope for this phase).
// A real .js file sidesteps the conflict — both `node *.ts` and `tsc --noEmit` resolve it
// the normal way.
//
// NEVER GUESS A TOKEN INTO THE REGISTRY. Every function here only reports what an actual
// HTTP response confirmed, and the confirmation rule is per-ATS (see EMPTY_BOARD_OK below)
// because "200 with an empty array" means different things on different platforms:
//   - greenhouse/lever/ashby/recruitee/teamtailor/pinpoint 404 on an unknown token
//     (verified by hand against each), so once we get a 200 with the right shape, the
//     token is real — even a genuinely open-less board must stay in the registry, or we'd
//     stop polling the exact company we most want to catch the next posting from.
//   - workable/smartrecruiters/workday return 200 + an empty shell for tokens that don't
//     exist at all (verified by hand), so for those three, status code alone isn't signal
//     and count > 0 is still required.

export const ATS_TYPES = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "workable",
  "recruitee",
  "workday",
  "teamtailor",
  "pinpoint",
];

// ATS families that 404 an unknown token, verified by hand with a bogus token per platform
// (see PR notes). For these, HTTP 200 + the expected array shape is itself the
// confirmation — the array may be empty (zero current openings is still a real board).
const EMPTY_BOARD_OK = new Set(["greenhouse", "lever", "ashby", "recruitee", "teamtailor", "pinpoint"]);

const USER_AGENT = "WorkieRegistryBot/0.1 (+mailto:dongyeop0810@gmail.com; company registry probe)";
const MIN_GAP_MS = 500; // max 2 req/s per host
const TIMEOUT_MS = 12000;

const lastRequestAt = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Reserves a per-host time slot synchronously (no `await` between read and write) so
// concurrent callers can't race each other into the same slot. ponytail: global in-memory
// map, fine for a one-shot script; a real daemon would want per-host queues persisted
// across runs, not needed here.
async function throttleHost(host) {
  const now = Date.now();
  const prev = lastRequestAt.get(host) ?? 0;
  const scheduled = Math.max(now, prev + MIN_GAP_MS);
  lastRequestAt.set(host, scheduled);
  const wait = scheduled - now;
  if (wait > 0) await sleep(wait);
}

async function fetchOnce(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      ...init,
      headers: { "User-Agent": USER_AGENT, ...(init && init.headers) },
      signal: controller.signal,
    });
    const text = await res.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null; // non-JSON 200s (e.g. an HTML error page) count as unparseable, not confirmed
    }
    return { status: res.status, body, error: null };
  } catch (err) {
    return { status: 0, body: null, error: err && err.message ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// One retry on network-level failures only (timeout/DNS/reset) — never on HTTP error
// statuses, which are a legitimate "not found" signal, not a transient blip.
async function fetchThrottled(url, init) {
  const host = new URL(url).host;
  await throttleHost(host);
  let result = await fetchOnce(url, init);
  if (result.error) {
    await sleep(300);
    await throttleHost(host);
    result = await fetchOnce(url, init);
  }
  return result;
}

// Exported so the Phase 3 connectors read their endpoint shapes from the same place the
// registry prober does — one file to fix when a vendor moves a path. The JSDoc is what gives
// TypeScript callers real parameter checking across the .js boundary.
/**
 * @param {string} ats
 * @param {string} token
 * @param {{ wdN?: string, site?: string, offset?: number }} [extra]
 * @returns {{ url: string, init?: RequestInit }}
 */
export function buildRequest(ats, token, extra) {
  switch (ats) {
    case "greenhouse":
      return { url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true` };
    case "lever":
      return { url: `https://api.lever.co/v0/postings/${token}?mode=json` };
    case "ashby":
      return { url: `https://api.ashbyhq.com/posting-api/job-board/${token}` };
    case "smartrecruiters":
      return { url: `https://api.smartrecruiters.com/v1/companies/${token}/postings` };
    case "workable":
      return { url: `https://apply.workable.com/api/v1/widget/accounts/${token}` };
    case "recruitee":
      return { url: `https://${token}.recruitee.com/api/offers/` };
    case "teamtailor":
      // JSON Feed spec (jsonfeed.org/version/1.1). Verified against a real tenant
      // (recruitgo.teamtailor.com/jobs.json) and confirmed 404-on-unknown-tenant.
      return { url: `https://${token}.teamtailor.com/jobs.json` };
    case "pinpoint":
      // Verified against Pinpoint's own career site (workwithus.pinpointhq.com/postings.json)
      // and confirmed 404-on-unknown-tenant. postings.json supersedes their older jobs.json.
      return { url: `https://${token}.pinpointhq.com/postings.json` };
    case "workday": {
      // `limit` is capped at 20 by the endpoint — asking for 100 returns HTTP 400 — so a large
      // board is read by paging. `offset` also rides in the QUERY STRING, which Workday ignores:
      // it is what makes each page a distinct URL, and both the fixture recorder and the rate
      // limiter key on URL. Without it every page would collide on one key and replay the same 20.
      const { wdN, site, offset = 0 } = extra;
      const base = `https://${token}.${wdN}.myworkdayjobs.com/wday/cxs/${token}/${site}/jobs`;
      return {
        url: offset > 0 ? `${base}?offset=${offset}` : base,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset, searchText: "" }),
        },
      };
    }
    default:
      throw new Error(`unknown ats type: ${ats}`);
  }
}

// Returns the postings array for a parsed body, or undefined if the body doesn't have the
// expected shape at all (wrong ats, malformed JSON, an HTML error page that happened to
// parse as something else, etc.) — undefined is what lets EMPTY_BOARD_OK tell "real board,
// zero openings" apart from "not even the right shape."
function postingsArray(ats, body) {
  if (body === null || body === undefined) return undefined;
  switch (ats) {
    case "greenhouse":
    case "ashby":
    case "workable":
      return Array.isArray(body.jobs) ? body.jobs : undefined;
    case "lever":
      return Array.isArray(body) ? body : undefined;
    case "smartrecruiters":
      return Array.isArray(body.content) ? body.content : undefined;
    case "recruitee":
      return Array.isArray(body.offers) ? body.offers : undefined;
    case "teamtailor":
      return Array.isArray(body.items) ? body.items : undefined;
    case "pinpoint":
      return Array.isArray(body.data) ? body.data : undefined;
    case "workday":
      return Array.isArray(body.jobPostings) ? body.jobPostings : undefined;
    default:
      return undefined;
  }
}

/**
 * Pure decision function — no I/O — so it's directly unit-testable without mocking fetch.
 * `status`/`body` are exactly what a probe received; see EMPTY_BOARD_OK for the per-ATS
 * rule this implements.
 */
export function isConfirmed(ats, status, body) {
  if (status !== 200) return false;
  const arr = postingsArray(ats, body);
  if (arr === undefined) return false; // 200 but not even the right shape — never confirmed
  return EMPTY_BOARD_OK.has(ats) ? true : arr.length > 0;
}

/**
 * Probe one (ats, token) pair. Returns a plain record suitable for both the
 * pass/fail decision and as evidence for the report / PR spot-check.
 */
export async function probeAts(ats, token, extra) {
  const { url, init } = buildRequest(ats, token, extra);
  const { status, body, error } = await fetchThrottled(url, init);
  const arr = postingsArray(ats, body);
  return {
    ats,
    token,
    wdN: extra && extra.wdN,
    site: extra && extra.site,
    url,
    status,
    count: arr ? arr.length : 0,
    confirmed: isConfirmed(ats, status, body),
    error,
  };
}

// lowercase, strip spaces/punctuation, plus the obvious with/without-hyphen and
// with/without-"inc" variants, plus the domain stem when a website is known.
export function candidateTokens(name, website) {
  const tokens = new Set();
  const lower = name.toLowerCase();
  const noPunct = lower.replace(/[^a-z0-9\s-]/g, "").trim();
  const slug = noPunct.replace(/[\s-]+/g, "");
  const hyphen = noPunct.replace(/\s+/g, "-");

  tokens.add(slug);
  tokens.add(hyphen);
  for (const t of [slug, hyphen]) {
    const stripped = t.replace(/-?(inc|llc|co|corp|ltd|ai)$/, "");
    if (stripped) tokens.add(stripped);
  }
  tokens.add(`${slug}inc`);
  tokens.add(`${slug}ai`);

  if (website) {
    try {
      const host = new URL(website.startsWith("http") ? website : `https://${website}`).hostname.replace(/^www\./, "");
      const stem = host.split(".")[0].toLowerCase();
      if (stem) tokens.add(stem);
    } catch {
      // malformed website hint — ignore, name-derived candidates still apply
    }
  }

  return [...tokens].filter(Boolean).slice(0, 6);
}

// The default sweep. Deliberately does NOT include teamtailor/pinpoint yet even though
// both are now confirmed-probeable (see EMPTY_BOARD_OK) — the construction plan's rule is
// "add them when the registry actually has a company on one, not before" (plans/workie.md
// Phase 3). Until a real company resolves through one, adding it here would just be extra
// request volume on every future run for a still-hypothetical benefit. Pass them via
// `extraAts` for a targeted attempt instead; promote to this array once one lands.
const FLAT_ATS_ORDER = ["greenhouse", "ashby", "lever", "workable", "smartrecruiters", "recruitee"];
const WORKDAY_WDN = ["wd1", "wd3", "wd5", "wd103"];

function workdaySiteGuesses(token) {
  const cap = token.charAt(0).toUpperCase() + token.slice(1);
  const upper = token.toUpperCase();
  return [
    token,
    cap,
    `${cap}Careers`,
    `${cap}ExternalCareerSite`,
    // Acronym brands upper-case the whole token: NVIDIA publishes `NVIDIAExternalCareerSite`,
    // which the capitalised form above misses because the path is case-sensitive.
    `${upper}ExternalCareerSite`,
    `${upper}Careers`,
    "External",
    "Careers",
  ];
}

// ---------------------------------------------------------------------------------------
// ATS detection from a careers page — for companies whose token is NOT derivable from the name
// ---------------------------------------------------------------------------------------
//
// A company like "The Browser Company" runs its board on Ashby under a token that no
// name/website slug produces, so `candidateTokens` never finds it and it falls into the
// unresolved report. The fix is not to scrape the postings out of the HTML — that is fragile,
// often JS-rendered, and a ToS grey area. It is to read the page ONLY to learn which ATS it
// delegates to and under what token: nearly every hosted career page links or embeds its ATS
// with the token in the URL (`jobs.lever.co/TOKEN`, `boards.greenhouse.io/embed/job_board?for=TOKEN`).
//
// Detection just proposes a candidate. It is still confirmed the same way every other token is
// — a real 200 from the ATS's own JSON API — so the "NEVER GUESS A TOKEN" rule holds: the HTML
// is never trusted for job content, only for the pointer to the real API.

// The token is captured group 1 in each. Ordered specific-before-generic so an API URL in the
// page (which already carries the exact token) wins over a human-facing one.
const ATS_SIGNATURES = [
  { ats: "greenhouse", re: /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i },
  { ats: "greenhouse", re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?(?:[^"'&]*&)?for=)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i },
  { ats: "lever", re: /(?:api\.lever\.co\/v0\/postings|jobs\.lever\.co)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i },
  { ats: "ashby", re: /(?:api\.ashbyhq\.com\/posting-api\/job-board|jobs\.ashbyhq\.com)\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i },
  { ats: "workable", re: /(?:apply\.workable\.com\/(?:api\/v1\/widget\/accounts\/)?|https?:\/\/)([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.workable\.com/i },
  { ats: "workable", re: /apply\.workable\.com\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i },
  { ats: "smartrecruiters", re: /(?:careers|jobs)\.smartrecruiters\.com\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/i },
  { ats: "recruitee", re: /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.recruitee\.com/i },
  { ats: "teamtailor", re: /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.teamtailor\.com/i },
  { ats: "pinpoint", re: /([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.pinpointhq\.com/i },
];

// Tokens that appear in these patterns but are the platform's own marketing pages, not a
// company board — never propose them.
const NOT_A_TOKEN = new Set(["embed", "www", "job_board", "job-board", "postings", "jobs", "api", "v0", "v1", "boards", "account", "accounts", "widget", "support", "help", "about", "blog"]);

const HTML_TIMEOUT_MS = 12000;
const CAREERS_PATHS = ["/careers", "/careers/", "/jobs", "/careers/jobs", "/company/careers", "/"];
const robotsCache = new Map();

async function fetchHtml(url) {
  const host = new URL(url).host;
  await throttleHost(host);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTML_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal,
    });
    // Cap the read: the ATS pointer is in the <head>/early body, and a full marketing page can
    // be megabytes. 512KB is plenty and bounds a hostile response.
    const text = (await res.text()).slice(0, 512 * 1024);
    return { status: res.status, text };
  } catch {
    return { status: 0, text: "" };
  } finally {
    clearTimeout(timer);
  }
}

// robots.txt Disallow → RegExp. Honors the two wildcards the spec defines: `*` is any run,
// `$` anchors the URL end. This is why a `Disallow: /*?` (query URLs) correctly does NOT block
// a plain `/careers` — the naive startsWith check that bit the jobspresso connector.
function disallowToRegex(pattern) {
  let re = "";
  for (const ch of pattern) {
    if (ch === "*") re += ".*";
    else if (ch === "$") re += "$";
    // Every other regex metachar is a literal in a robots pattern and must be escaped — `?`
    // above all, since `/*?` (query-string rule) is common and an unescaped `?` becomes a lazy
    // quantifier that wrongly matches a plain `/careers`.
    else re += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp("^" + re);
}

/**
 * Is `pathname` allowed for `User-agent: *` by this robots.txt body? Pure, so the wildcard
 * handling that the naive startsWith check got wrong (a `Disallow: /*?` must NOT block a plain
 * `/careers` — the exact bug that kept the jobspresso connector dead) is testable offline.
 * @param {string} robotsText
 * @param {string} pathname
 * @returns {boolean}
 */
export function robotsPathAllowed(robotsText, pathname) {
  const rules = [];
  let appliesToUs = false;
  for (const raw of robotsText.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const m = /^([a-z-]+)\s*:\s*(.*)$/i.exec(line);
    if (!m) continue;
    const field = m[1].toLowerCase();
    const value = m[2].trim();
    if (field === "user-agent") appliesToUs = value === "*";
    else if (field === "disallow" && appliesToUs && value) rules.push(disallowToRegex(value));
  }
  return !rules.some((re) => re.test(pathname));
}

async function robotsAllows(url) {
  const u = new URL(url);
  let text = robotsCache.get(u.host);
  if (text === undefined) {
    text = "";
    try {
      const res = await fetch(`${u.protocol}//${u.host}/robots.txt`, {
        headers: { "User-Agent": USER_AGENT },
        signal: AbortSignal.timeout(HTML_TIMEOUT_MS),
      });
      if (res.status === 200) text = await res.text();
    } catch {
      text = ""; // no reachable robots.txt is treated as no restriction, the conventional default
    }
    robotsCache.set(u.host, text);
  }
  return robotsPathAllowed(text, u.pathname);
}

/**
 * Read a company's careers page(s) to detect which ATS + token it uses. Returns candidate
 * `{ ats, token }` pairs (deduped, never confirmed here) for `resolveCompany` to verify against
 * the real API. Respects robots.txt; skips a path it disallows. Never throws.
 *
 * @param {string} website
 * @returns {Promise<{ ats: string, token: string }[]>}
 */
export async function detectAtsFromCareers(website) {
  let origin;
  try {
    const u = new URL(website.startsWith("http") ? website : `https://${website}`);
    origin = `${u.protocol}//${u.host}`;
  } catch {
    return [];
  }
  const found = new Map(); // `${ats}:${token}` -> {ats, token}, first-seen wins
  for (const path of CAREERS_PATHS) {
    const url = `${origin}${path}`;
    if (!(await robotsAllows(url))) continue;
    const { status, text } = await fetchHtml(url);
    if (status !== 200 || !text) continue;
    for (const { ats, token } of matchAtsSignatures(text)) found.set(`${ats}:${token}`, { ats, token });
    if (found.size > 0) break; // one page that names its ATS is enough
  }
  return [...found.values()];
}

/**
 * The pure core of detection: pull `{ ats, token }` candidates out of one page's HTML. Split
 * out so the signature set and the token filter are testable without the network.
 * @param {string} text
 * @returns {{ ats: string, token: string }[]}
 */
export function matchAtsSignatures(text) {
  const found = new Map();
  for (const sig of ATS_SIGNATURES) {
    const m = sig.re.exec(text);
    if (!m) continue;
    const token = m[1].toLowerCase();
    if (NOT_A_TOKEN.has(token) || token.length < 2) continue;
    const key = `${sig.ats}:${token}`;
    if (!found.has(key)) found.set(key, { ats: sig.ats, token });
  }
  return [...found.values()];
}

/**
 * Try every (ats, token) combination for one company, cheapest ATS families first,
 * stopping at the first confirmed hit. Always returns — never throws — so a single
 * bad company can't abort a run.
 *
 * `extraAts`: additional ATS types to try after the default sweep and before Workday —
 * for platforms confirmed-probeable but not yet promoted into FLAT_ATS_ORDER (see above).
 *
 * Workday is opt-in (`tryWorkday`) and off by default: wdN x site-guesses multiplies
 * fast (tenant x 4 wdN x 6 site guesses), and Workday is not a plausible ATS for an
 * early-stage startup — nobody running a 20-person company buys an HR suite built for
 * 5,000 employees. Callers should only set it for company-by-company cases where there's
 * an actual reason to think Workday applies (e.g. a large, established employer).
 */
/**
 * @param {string} name
 * @param {string} [website]
 * @param {{ tryWorkday?: boolean, extraAts?: string[], detect?: boolean }} [options]
 */
export async function resolveCompany(
  name,
  website,
  { tryWorkday = false, extraAts = [], detect = false } = {},
) {
  const tokens = candidateTokens(name, website);
  const attempts = [];

  for (const ats of [...FLAT_ATS_ORDER, ...extraAts]) {
    for (const token of tokens) {
      const result = await probeAts(ats, token, {});
      attempts.push(result);
      if (result.confirmed) return { confirmed: result, attempts };
    }
  }

  if (tryWorkday) {
    for (const token of tokens.slice(0, 2)) {
      for (const wdN of WORKDAY_WDN) {
        for (const site of workdaySiteGuesses(token)) {
          const result = await probeAts("workday", token, { wdN, site });
          attempts.push(result);
          if (result.confirmed) return { confirmed: result, attempts };
        }
      }
    }
  }

  // Last resort, and only when asked: the name gave us nothing, so read the careers page to
  // find the ATS it points at. The detected token is still confirmed against the API below,
  // never trusted from the HTML.
  if (detect && website) {
    for (const candidate of await detectAtsFromCareers(website)) {
      const result = await probeAts(candidate.ats, candidate.token, {});
      attempts.push(result);
      if (result.confirmed) return { confirmed: result, attempts };
    }
  }

  return { confirmed: null, attempts };
}
