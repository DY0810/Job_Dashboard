# Worky — Construction Plan

**Objective:** A local job dashboard that ingests postings from ATS APIs and aggregator
feeds, dedupes them, classifies them with one cached LLM call each, and serves a two-tab
filterable table.

**Stack:** Next.js 15 App Router · TypeScript (strict) · Tailwind v4 · Drizzle ORM over
SQLite (`better-sqlite3`) · connectors as standalone Node scripts run by cron · single
repo, runs locally.

**Mode:** `git init` + private GitHub repo. One branch + PR per phase. A phase merges only
when its gate passes. `gh` is authenticated as `dongyeop-cmyk`; node v22.22.1.

**Design context:** [`.impeccable.md`](../.impeccable.md) — read it before any UI phase.
It is the tiebreaker where the loaded design skills disagree, and it records which of
their directives were deliberately rejected.

---

## 0. Decisions locked before Phase 0

These are settled. Do not relitigate them mid-execution; use the mutation protocol in §7
if one turns out to be wrong.

| Decision | Choice | Why |
| --- | --- | --- |
| **No REST API** | Filters, tab, sort, and open-drawer are all URL search params. Server components query Drizzle directly. | Back button and bookmarkable filter sets come free, there is no client state library, and clicking a badge is a `<Link>`. One route handler total (see below). |
| **One route handler** | `GET /api/postings/[id]` returns drawer-only fields. | Full description bodies across ~2k postings would be ~8MB in the initial payload. Everything else the table needs is already in the row. |
| **Drawer is `<dialog>`** | Native element + `showModal()`. | Esc-to-close, top-layer, backdrop, and focus return are platform behavior. No Radix, no drawer library. Animate with `@starting-style` + `transition-behavior: allow-discrete`. |
| **Icons are inline SVG** | Three of them: external-link, chevron, close. | A whole icon package for three glyphs fails the ladder. No emoji anywhere (banned by three loaded skills). |
| **Fonts** | Archivo variable, self-hosted via `next/font/google`. | See `.impeccable.md`. One family covers narrow table rows and expanded tab labels via the `wdth` axis. |
| **SQLite driver** | `better-sqlite3` | Synchronous, well-trodden with Drizzle, works in both the Next server context and the standalone connector scripts. `node:sqlite` is the zero-native-dep alternative if the build ever fights us. |
| **LLM** | `claude-haiku-4-5-20251001` via `@anthropic-ai/sdk`, structured output. | Spec'd. Key in `.env.local`, never committed; `.env.example` is committed. |
| **Tests** | `vitest`. Fixtures over network in CI. | Every connector records a snapshot fixture on first successful live run so the suite runs offline forever after. |

**Tailwind v4 guard:** use `@tailwindcss/postcss` in `postcss.config.js`, *not* the
`tailwindcss` plugin. Wrong entry is the standard v4 setup failure.

---

## 1. Architecture

```
scripts/                     standalone node, run by cron, never imported by Next
  ingest.ts                  orchestrator: runs every enabled connector, isolated
  enrich.ts                  Haiku pass over un-enriched postings
  linkcheck.ts               HEAD every canonical_url, report dead
  connectors/
    ats/       greenhouse lever ashby smartrecruiters workable recruitee workday
    agg/       hn remoteok remotive arbeitnow adzuna careerjet jooble usajobs
    rss/       weworkremotely jobspresso workingnomads
    repo/      simplify-internships  yc-directory
    scrape/    (phase 11, gated on robots.txt)

lib/
  normalize.ts               company · title · location  (pure, no I/O)
  dedupe.ts                  key, priority merge, near-dupe, ghost, 60-day cutoff
  geo.ts                     GEO_TIER — the ONLY place geo priority is defined
  classify.ts                Haiku call + content-hash cache + prefilter
  voice.ts                   weighted keyword scorer over description body
  runtime.ts                 fetch/timeout/ratelimit/robots/retry/isolation
  db/  schema.ts  index.ts

app/
  layout.tsx  page.tsx       tabs, filters, table — server components
  api/postings/[id]/route.ts the one handler

companies.ts                 registry: { name, ats, token, wdN?, site? }
```

**Data model (four tables):**

- `postings` — one row per *deduped* job. Holds `dedupe_key`, `canonical_url`,
  `posted_at` (the merged MIN), the classification fields, `delisted_at`, `first_seen_run`.
- `posting_sources` — one row per (posting, source). Holds that source's own URL, its own
  `posted_at`, `source_priority`, and `last_seen_run`. **Never discard a source.**
- `enrichment_cache` — keyed on `sha256(normalized_description)` → the classification JSON.
  Survives posting deletion; this is what makes a full re-poll cost ~$0.
- `connector_runs` — one row per (run, connector): status, counts, duration, error. Ghost
  detection reads this to know whether an absence was real or just a failed fetch.

---

## 2. Dependency graph

```
P0 rails
 └─ P1 normalize + dedupe + schema        ← everything keys off this
     └─ P2 connector runtime
         └─ P3 Tier-1 ATS connectors
             ├─ P4 classification (Haiku + cache)   ─┐
             ├─ P5 voice-AI detection                ├─ parallel after P3
             ├─ P6 Tier-2 aggregators                │
             └─ P7 design system + shell            ─┘
                 └─ P8 table + filters + sort   (needs P4 fields, P7 tokens)
                     └─ P9 detail drawer + link checker
                         └─ P10 cron + ghost + ops   (needs P6 for a real multi-source run)
                             └─ P11 Tier-3 scrapers  ← optional, ship without it
```

**Parallel window:** P4, P5, P6, P7 have no shared files and no output dependency on each
other. P7 touches only `app/` and tokens; P4/P5 touch only `lib/` and `scripts/`; P6 touches
only `scripts/connectors/`. Four agents can run this window concurrently.

**Critical path:** P0 → P1 → P2 → P3 → P4 → P8 → P9 → P10. Eight phases. P5, P6, P7 ride
alongside. P11 is optional and the acceptance criteria are all reachable without it.

**Invariants checked after every phase, no exceptions:**

1. `npm run build` clean, `npx tsc --noEmit` clean.
2. `npm test` green.
3. `git grep -nE "sk-ant|ghp_|API_KEY *= *['\"][^'\"]" -- ':!.env.example'` returns nothing.
4. No senior/staff/principal/lead/director/manager row is visible in either tab.
5. `SELECT dedupe_key, COUNT(*) FROM postings GROUP BY 1 HAVING COUNT(*) > 1` returns zero rows.

---

## 3. Phases

### Phase 0 — Rails
`worky/p0-rails` · no dependencies · **model: default**

**Context brief.** `/Users/dyl/Job_Dashboard` is empty. Nothing exists yet — not a git repo,
not a package. This phase produces a repo that builds and a database file that migrates,
and nothing else. Resist scaffolding anything a later phase owns.

**Build.**
- `git init`; `gh repo create Job_Dashboard --private --source=. --remote=origin`.
- `create-next-app` — App Router, TypeScript, Tailwind v4, no `src/`, no ESLint prompt noise.
- Add `drizzle-orm`, `drizzle-kit`, `better-sqlite3`, `zod`, `vitest`, `@anthropic-ai/sdk`.
- `.gitignore` covers `.env.local`, `*.db`, `*.db-wal`, `*.db-shm`, `/fixtures/live`.
- `.env.example` with `ANTHROPIC_API_KEY=`, `ADZUNA_APP_ID=`, `ADZUNA_APP_KEY=`,
  `JOOBLE_KEY=`, `CAREERJET_AFFID=`, `USAJOBS_KEY=`, `USAJOBS_EMAIL=` — all empty.
- `npm scripts`: `ingest`, `enrich`, `linkcheck`, `db:migrate`, `db:studio`, `test`.
- One empty `postings` migration proving the Drizzle toolchain round-trips.
- `README.md`: the four commands and where the db file lives. Nothing aspirational.

**Gate.**
- `npm run build` and `npx tsc --noEmit` both clean.
- `npm run db:migrate` creates `worky.db`; `sqlite3 worky.db .tables` lists `postings`.
- `npm test` exits 0 with zero tests (harness proven, not faked).
- `gh repo view --json visibility` reports `PRIVATE`.
- `git status --porcelain` clean, `.env.local` absent from `git ls-files`.

**Rollback.** Delete the directory. Nothing downstream exists.

---

### Phase 1 — Normalizers, dedupe engine, schema
`worky/p1-dedupe` · after P0 · **model: strongest**

> **The spec is explicit: build this before any connector.** Every downstream phase keys
> off `dedupe_key`. Getting it wrong after connectors exist means reprocessing everything.

**Context brief.** Pure functions and a schema. No network, no LLM, no UI. The same
Greenhouse posting will arrive from six aggregators with six different spellings of the
company, six title variants, and six posted-at timestamps; this phase decides they are one
row. Everything here is deterministic and unit-testable with zero I/O.

**Build.**
- `lib/normalize.ts`
  - `normalizeCompany` — lowercase, strip legal suffixes `(inc|llc|ltd|corp|co|gmbh|sa)`
    as whole trailing tokens only (never inside a word — "Cisco" must not become "Cis"),
    strip punctuation, collapse whitespace.
  - `normalizeTitle` — lowercase, strip req IDs, strip bracketed and parenthesized
    suffixes, strip trailing location, collapse whitespace.
  - `normalizeLocation` → `{ city_norm, state, country, is_remote }` with the exact
    alias tables from the spec (sf / la / nyc / sea), `state = 'CA'` for **any** recognized
    California city (not only the two metros), `is_remote` from
    `work from home | anywhere | distributed` with `city_norm = null`.
  - `normalizeDescription` — **strip HTML, decode entities, collapse whitespace.**
    Greenhouse returns escaped HTML, Lever returns `descriptionPlain` + `lists[]`, Ashby
    returns markdown. This function is what makes the enrichment cache hit; see §5 finding B.
- `lib/geo.ts` — `GEO_TIER` exactly as specced, exported as the single editable constant.
  Nothing else in the repo may hardcode a city or a tier.
- `lib/dedupe.ts`
  - `dedupeKey = sha256(company|title|location)` with a **pinned** serialization for the
    location component (remote and null must produce stable, distinct strings).
  - Priority merge: `1 ATS direct · 2 aggregator API · 3 RSS · 4 scraped · 5 GitHub repo`.
  - `canonical_url` = the ATS URL if **any** source is an ATS, else highest-priority URL.
  - `posted_at` = MIN across sources, **floored at the ATS source's date when one exists**
    (see §5 finding D).
  - `sources[]` retains every source URL and its own `posted_at`. Never discarded.
  - Near-dupe: same company + location AND title token-set ratio ≥ 0.90 → merge.
    **Pin the algorithm in a docstring with worked examples** — "token-set ratio" is
    ambiguous and an ad-hoc implementation will drift (see §5 finding E).
  - Ghost: delisted after absent from a source for 2 consecutive polls **in which that
    source's connector run succeeded** (see §5 finding C — this is not optional).
  - 60-day cutoff as a query-level filter, not a delete.
- `lib/db/schema.ts` — the four tables from §1, with a unique index on
  `postings.dedupe_key` and on `posting_sources(posting_id, source_url)`.

**Gate.** This gate is the load-bearing one in the whole plan.
- **Golden corpus:** one real job hand-transcribed as it appears on Greenhouse, Lever,
  RemoteOK, Remotive, a WWR RSS item, and a SimplifyJobs README row. All six collapse to
  exactly **one** posting with **six** `posting_sources` rows, `canonical_url` pointing at
  Greenhouse, and `posted_at` equal to the earliest.
- **Idempotency property test:** `normalize(normalize(x)) === normalize(x)` for all three
  normalizers across a generated input set.
- **Suffix-strip safety:** "Cisco", "Coinbase", "Incident.io", "Ltd Commodities" survive
  `normalizeCompany` intact.
- **GEO_TIER table test** covering: every city in each alias list → 0 · Sacramento and
  San Diego → 1 (CA but not a named metro — the case a naive implementation fails) ·
  a `work from home` posting → 2 · Berlin → 3.
- **Near-dupe boundary:** "Product Designer" vs "Product Designer II" and "Software
  Engineer, Backend" vs "Backend Software Engineer" each land on the documented side of
  0.90, with the expected value asserted rather than observed.
- **Ghost negative test:** a source that returned HTTP 500 on both polls does **not**
  delist its postings.

**Rollback.** `git revert` the merge. P0 stands alone.

---

### Phase 2 — Connector runtime
`worky/p2-runtime` · after P1 · **model: default**

**Context brief.** The shared harness every connector runs inside. No connector logic here
— this phase ships the thing that makes "every connector fails independently" true, and
proves it with fake connectors before any real one exists.

**Build.**
- `lib/runtime.ts`: `fetchJson` with timeout and abort · per-host token-bucket rate limiter
  · `robots.txt` fetch + parse + 24h cache with allow/deny per path · retry with jittered
  backoff on 429/5xx only · a descriptive UA string with a contact address.
- `scripts/ingest.ts`: runs all enabled connectors under `Promise.allSettled`, writes one
  `connector_runs` row per connector per run (status · fetched · new · merged · duration ·
  error), exits 0 when *any* connector succeeded, exits 1 only when *all* fail.
- Flags: `--only=<name>` · `--dry-run` (fetch and normalize, write nothing) · `--since=`.
- Structured JSON log line per connector. Errors carry the connector name and never a key.

**Gate.**
- Three fake connectors — one healthy, one throwing 500, one hanging past the timeout.
  A single run completes, records three rows with the right statuses, writes the healthy
  connector's postings, and exits 0.
- Rate limiter test asserts ≥ *N* ms spacing between two requests to the same host and
  no added delay across different hosts.
- A `robots.txt` fixture with `Disallow: /jobs` causes a fetch to that path to be refused
  before any network call is attempted.
- No secret appears in any log line (grep the captured output).

**Rollback.** Revert. P1 is untouched.

---

### Phase 3 — Tier-1 ATS connectors
`worky/p3-ats` · after P2 · **model: default**

**Context brief.** The clean sources: canonical JSON, no bot detection, and always the
preferred `canonical_url` when a job appears elsewhere too. Seven connectors, all reading
into the same normalized shape from Phase 1. Workday is the odd one and gets its own task.

**Build.**
- `companies.ts` — the registry. `{ name, ats, token, wdN?, site? }`. This file is data,
  not code; every connector reads its targets from here.
- Connectors, each ~40 lines given the Phase 2 runtime:
  - Greenhouse `boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
  - Lever `api.lever.co/v0/postings/{company}?mode=json`
  - Ashby `api.ashbyhq.com/posting-api/job-board/{name}`
  - SmartRecruiters `api.smartrecruiters.com/v1/companies/{company}/postings`
  - Workable `apply.workable.com/api/v1/widget/accounts/{id}`
  - Recruitee `{company}.recruitee.com/api/offers/`
  - Workday `{tenant}.wdN.myworkdayjobs.com/wday/cxs/{tenant}/{site}/jobs` — **POST**
    with a JSON body, offset pagination, and a per-tenant `wdN` that varies (wd1, wd3,
    wd5, wd103). `wdN` and `site` live in the registry; never guess them.
- Seed the registry: design and game studios skew Workable/Teamtailor/Workday; AI startups
  skew Ashby/Greenhouse. Populate accordingly.
- Rippling, Pinpoint, Teamtailor, BambooHR: **deferred.** Same shape, lower volume. Add
  them when the registry actually has a company on one, not before.
- Record a snapshot fixture per connector on first successful live run.

**Gate.**
- Each of the seven returns ≥ 1 posting from a real live token, and each maps to the
  canonical shape with `posted_at`, `canonical_url`, and a non-empty description.
- Full ingest run twice back to back → the second run creates **zero** new `postings`
  rows and increments `last_seen_run` on existing `posting_sources`.
- Offline suite passes against the recorded fixtures with the network unplugged.
- A company deliberately given a bad token logs one failure and does not abort the run.

**Rollback.** Revert. Registry entries can be re-added individually later.

---

### Phase 4 — Classification
`worky/p4-classify` · after P3 · parallel with P5/P6/P7 · **model: strongest**

**Context brief.** One Haiku call per **new** posting, cached forever on the content hash,
so a full re-poll costs ~$0. The cache key is `sha256(normalizeDescription(body))` — the
*normalized* body, not the raw one, or whitespace churn re-bills you.

**Build.**
- **Two-layer seniority drop.** A regex prefilter runs *before* the LLM and drops the
  obvious cases — senior, staff, principal, lead, director, manager, `[5-9]\+? *years`,
  `\d{2}\+ *years`. It is cheap and saves the API call. The LLM then classifies the
  survivors and drops the rest. Precision from the regex, recall from the model.
- Structured output (tool-use / JSON schema, not prose parsing) extracting exactly:
  `track` (design | engineering — drop everything else) · `seniority` (entry | junior |
  mid | senior+) · `employment_type` · `internship_season` · `paid` · `work_mode` ·
  `location` · `pay_rate {min,max,period}` · `expected_grad` · `summary` ·
  `responsibilities[]` · `skills[]` · `education[]` · `badges[]`.
- `summary` is **engineering only** — the Design tab has no summary column, so don't
  generate one. Free token savings.
- `responsibilities[]` and `skills[]` are plain bullets. The prompt explicitly rejects
  marketing copy; the fixture set includes a posting stuffed with it.
- Per-run spend cap read from env, enforced by a running token counter that stops the
  loop cleanly rather than throwing. Log calls made, cache hits, and estimated cost.
- Cache lookup happens before anything else; a cached posting never touches the API.

**Gate.**
- **50-posting hand-labeled fixture set**, ~15 of which are senior/staff/principal/lead
  or 5+ years. Hard-drop recall on that subset is **100%** — zero leaks. This is an
  acceptance criterion and it does not get a "close enough."
- Re-run over the same 50 makes **zero** API calls and logs $0.00 spend.
- Whitespace/HTML churn test: the same posting with reformatted HTML hits the same cache
  row.
- Spend cap test: a cap of 5 calls against 50 uncached postings stops at 5, exits 0, and
  logs the remaining backlog.
- `track` other than design/engineering is dropped, not stored.

**Rollback.** Revert code; `enrichment_cache` rows are harmless if left (they are keyed by
content and will simply be re-validated).

---

### Phase 5 — Voice-AI detection
`worky/p5-voice` · after P3 · parallel with P4/P6/P7 · **model: default**

**Context brief.** Voice AI is a company-list problem, not a board problem — there is no
voice-AI job board. Resolve seed companies to ATS tokens, poll them directly, and match on
the **description body, never the title.** Titles are never "Voice AI Engineer" — they are
"Member of Technical Staff," "Forward Deployed Engineer," "Applied AI Engineer." Voice
roles surface in the **Engineering tab with a `voice-ai` badge. There is no third tab.**

**Build.**
- **5a — Verify and resolve the seed list.** For each of Vapi, Retell, Bland, LiveKit,
  Daily, Deepgram, Cartesia, ElevenLabs, AssemblyAI, Rime, Speechmatics, Hume, Krisp,
  Sesame, Telnyx, Twilio, PolyAI, Cresta, Sierra, Decagon, Parloa, Observe.AI, Replicant,
  Regal, Synthflow, Kustomer, Assort Health, Infinitus, Hello Patient, Arini, ConverseNow,
  Slang.ai, Numa, Toma, Impel, Avoca, HappyRobot, Fleetworks, Vooma, Liberate, Salient,
  Alex: confirm the company still exists, find its ATS and token, add it to `companies.ts`.
  **This list turns over fast** — record dead or acquired ones as a commented line with the
  date checked, so the next pass knows they were checked and not missed.
- **5b — `lib/voice.ts`**, a weighted scorer over the normalized description:
  - **High weight (near-zero false positive):** barge-in · endpointing · turn detection.
  - Standard weight: telephony · SIP · WebRTC · latency budget · ASR · STT · TTS ·
    speech-to-speech · diarization · LiveKit · Pipecat · Twilio · Vapi · Retell ·
    Deepgram · Cartesia · ElevenLabs · voice agent · conversational AI · IVR.
  - Threshold: one high-weight term, or two standard terms. Tunable constant, one place.
  - Word-boundary matching. `IVR` must not fire on "driver"; `TTS` must not fire inside
    another token.

**Gate.**
- Every seed company is resolved to `{ats, token}` **or** recorded dead with a date.
  Zero silent omissions — the count in `companies.ts` plus the commented-dead count
  equals the seed list length.
- 20 hand-labeled descriptions including adversarial negatives: a customer-research role
  mentioning "voice of the customer," a design role mentioning "brand voice," and a
  posting whose *title* contains "Voice" but whose body has none of the terms — all three
  must **not** match.
- A posting matching only on title scores 0. Asserted directly.
- Every `voice-ai` badge in the DB belongs to a posting with `track = 'engineering'`.

**Rollback.** Revert `lib/voice.ts`; registry additions are independently useful and can stay.

---

### Phase 6 — Tier-2 aggregators
`worky/p6-aggregators` · after P3 · parallel with P4/P5/P7 · **model: default**

**Context brief.** Real APIs and feeds — never scraping at this tier. These syndicate ATS
postings, so this is the phase where the Phase 1 dedupe engine finally gets exercised against
reality. **The "zero cross-source duplicates" acceptance criterion is verified here.**

**Build.**
- API/JSON: HN "Who is Hiring" via `hn.algolia.com/api/v1` (best signal-to-noise for
  AI/infra) · RemoteOK JSON · Remotive · Arbeitnow · Adzuna · Careerjet · Jooble · USAJobs.
- RSS via `rss-parser`: We Work Remotely · Jobspresso · Working Nomads.
- GitHub README table parsers: SimplifyJobs/Summer-Internships and siblings.
- YC company directory JSON + Work at a Startup.
- Keyed sources (Adzuna, Careerjet, Jooble, USAJobs) read from `.env.local` and **skip
  cleanly with a logged notice** when the key is absent. A missing key is not an error.
- **HN needs a company-extraction step.** Its entries are freeform comment text with no
  structured company field, which makes them the highest dedupe risk in the system
  (see §5 finding A). Route HN entries through a single Haiku extraction call — cached on
  the comment hash like everything else — rather than a regex.

**Gate.**
- Full multi-source run across all of Tier 1 + Tier 2, then:
  - `SELECT dedupe_key, COUNT(*) FROM postings GROUP BY 1 HAVING COUNT(*) > 1` → **zero rows.**
  - `SELECT company_norm, title_norm, location_key, COUNT(*) ... HAVING COUNT(*) > 1` → **zero rows.**
  - Every posting with ≥ 1 ATS source has `canonical_url` on the ATS domain. Asserted by query.
  - At least 5 postings carry ≥ 3 `posting_sources` rows — proving merges actually happened
    rather than the sources simply not overlapping.
- HN specifically: sample 20 extracted companies, hand-verify, ≥ 18 correct.
- A missing API key skips its connector and the run still exits 0.

**Rollback.** Revert. Per-connector disable flag lets one bad source be dropped without
reverting the phase.

---

### Phase 7 — Design system and shell
`worky/p7-shell` · after P1 (needs `GEO_TIER` only) · parallel with P4/P5/P6 · **model: strongest**

**Context brief.** Read [`.impeccable.md`](../.impeccable.md) first — it resolves the
conflicts between the loaded design skills and records what was rejected. This phase ships
tokens, type, both themes, the tab shell, and all six states. **No table yet** — that is
Phase 8, and keeping them apart keeps this gate about contrast and theme rather than sort
correctness.

**Build.**
- OKLCH token layer, both themes. `:root` carries the full light palette; only the tokens
  are redefined under `@media (prefers-color-scheme: dark)` guarded as
  `:root:not([data-theme="light"])`, and again under `:root[data-theme="dark"]` so a
  manual override wins in both directions. `body` gets an explicit token background.
- Archivo variable via `next/font/google`, self-hosted. Three widths per `.impeccable.md`.
  Verify the `wdth` axis is exposed; fall back to static Archivo + Archivo Narrow if not.
- Tab shell: Design / Engineering. Indicator slides 150ms; content swaps instantly
  (dozens of switches a day — animating the content would make a hot path feel slow).
- The six states, each real: empty (names the ingest command, does not say "No jobs yet")
  · loading · error · focus · disabled · zero-results-after-filter.
- Page shell asymmetry: title left, last-run status right, filter row full-bleed. No cards
  anywhere — hairline rules and negative space only.

**Gate.**
- Contrast: every text token against its surface passes WCAG AA in **both** themes,
  measured and recorded in a table, not eyeballed.
- Theme matrix renders correctly in all four states: system-light, system-dark,
  forced-light, forced-dark. No token gets its only definition inside a media query.
- `prefers-reduced-motion: reduce` honored.
- Banned-pattern grep returns nothing:
  `border-left:` with width > 1px · `background-clip: *text` · `Inter|Roboto|Open Sans`
  · any emoji in `app/` or `components/`.
- Keyboard: tab order reaches every control; focus rings visible in both themes.
- All six states screenshot-verified, including zero-results.

**Rollback.** Revert. Nothing else imports the tokens yet.

---

### Phase 8 — Table, filters, sort
`worky/p8-table` · after P4 and P7 · **model: strongest**

**Context brief.** The two tabs differ in columns, filters, and — critically — in sort.
Design is geo-weighted; Engineering is **not**. Badges *are* the filter values: clicking a
badge applies it. All filter state lives in the URL.

**Build.**

*Engineering tab*
- Columns: time posted · badges · summary · pay rate · experience level · expected grad
  date · company · apply button.
- Filters: posted within hour/day/week/month · full-time · internship · paid/unpaid ·
  remote/hybrid/onsite · summer/fall/winter/spring · junior/mid.
- Sort: posted-within-24h bucket desc → `posted_at` desc → entry/junior above mid.
  **No geo weighting.**

*Design tab*
- Columns: time posted · badges · pay rate · company · apply button.
- Filters: posted within last week (only) · full-time/freelance/part-time/internship ·
  paid/unpaid · remote/hybrid/onsite · junior/mid.
- Sort, four keys in order: posted-within-24h desc → `GEO_TIER` asc → `posted_at` desc →
  entry/junior above mid.

*Both*
- `entry` folds into the `junior` chip (there is no `entry` chip, but entry sorts above
  mid — see §5 finding F).
- `paid = unknown` matches neither the paid nor the unpaid chip, but **is** visible when
  no paid filter is active (§5 finding G).
- Sorting happens in SQL via Drizzle; filters compile from validated search params.
- Zod validates search params — they are a trust boundary even locally.

**Gate.** Constructed fixtures where a naive sort gets the wrong answer:
- **Design 4-key order:** two postings identical except `GEO_TIER` (SF vs Berlin) → SF
  first. Then a Berlin posting from 2 hours ago vs an SF posting from 3 days ago → **Berlin
  first**, because the 24h bucket outranks geo. This is the case a 3-key implementation fails.
- **Engineering has no geo weighting:** an SF and a Berlin posting with identical
  `posted_at` sort identically regardless of location. Asserted directly.
- **Tie-break depth:** two postings identical through key 3, differing only in seniority →
  entry above mid, on both tabs.
- Clicking a badge applies exactly that filter and updates the URL; back button restores
  the prior filter set; a copied URL reproduces the view in a fresh session.
- No senior/staff/principal/lead/director/manager row appears in either tab under any
  filter combination — including with all filters cleared.
- 60-day-old postings are absent from both tabs.

**Rollback.** Revert. P7 shell still renders with the empty state.

---

### Phase 9 — Detail drawer and link integrity
`worky/p9-drawer` · after P8 · **model: default**

**Context brief.** Same drawer on both tabs. Native `<dialog>` — the platform already does
Esc, top-layer, backdrop, and focus return. Occasional interaction (~5/day), so this is one
of the three animations in the app's entire motion budget.

**Build.**
- Drawer content: job title · company · **LOCATION** (present on both tabs even though only
  Engineering shows it in a column) · full job details · responsibilities as bullets ·
  skills/requirements as bullets · education/experience as bullets · apply button →
  `canonical_url`.
- `GET /api/postings/[id]` — the one route handler. Zod-validated param, 404 on unknown id,
  never leaks a SQL error. Deep-linkable via `?job=<id>`.
- Motion: 220ms enter / 165ms exit, `translateX` + opacity, `cubic-bezier(0.32,0.72,0,1)`,
  `@starting-style` + `transition-behavior: allow-discrete`. Opacity-only under reduced motion.
- `scripts/linkcheck.ts` — HEAD every `canonical_url`, rate-limited, reports non-200 and
  known ATS "no longer available" body markers (some ATS endpoints return 200 for a dead
  job — see §5 finding H).

**Gate.**
- Every drawer field renders for a posting from each of the seven ATS connectors, plus one
  RSS-sourced and one GitHub-sourced posting — the sparse ones are where missing-field
  handling breaks.
- Keyboard: Esc closes, focus returns to the originating row, tab is trapped while open.
- `npm run linkcheck` over the full DB: **every** apply link resolves to a live posting.
  Dead links are reported with their posting id and marked, not silently dropped.
- Deep link `?job=<id>` opens the drawer on load; back closes it.
- Reduced-motion path verified.

**Rollback.** Revert. The table still functions without the drawer.

---

### Phase 10 — Cron, ghost detection, ops
`worky/p10-ops` · after P6 and P9 · **model: default**

**Context brief.** Makes it run unattended. Ghost detection is the subtle part: a posting is
delisted only after being absent from **two consecutive successful polls** of its source. A
connector returning 500 must never delist anything.

**Build.**
- launchd plist (macOS-native — no cron daemon needed): `ingest` on a schedule, `enrich`
  after it, `linkcheck` weekly. Logs to a rotating file.
- Ghost pass: increment absence only when that source's `connector_runs` row for the poll
  is `ok`. Two consecutive → `delisted_at`. Any reappearance resets the counter.
- 60-day hide applied at query level.
- `npm run status` — last run per connector, postings added, cache hit rate, spend to date.

**Gate.**
- **Ghost simulation, three runs:** posting present at run 1, absent at run 2 → **not**
  delisted. Absent again at run 3 → delisted. Reappears at run 4 → `delisted_at` cleared.
- **Ghost negative:** source errors at runs 2 and 3 → nothing delisted, absence counter
  unchanged.
- 60-day boundary asserted at exactly 59, 60, and 61 days.
- launchd job fires on schedule and a full unattended cycle completes end to end.
- Enrichment cost for a full re-poll of an unchanged corpus is **$0.00** in the spend log.

**Rollback.** `launchctl unload` the plist; revert the code. Data is unaffected.

---

### Phase 11 — Tier-3 scrapers *(optional — ship without it)*
`worky/p11-scrape` · after P10 · **model: default**

**Context brief.** Lowest source priority, scraped only where `robots.txt` permits, always
rate-limited. Every acceptance criterion is reachable without this phase; it exists to widen
coverage on design and game boards that have no API.

**Build.**
- **Verify each target is alive before wiring it.** Krop and CreativeHeads are dead.
  Candidates: ai-jobs.net · Wellfound · Hugging Face Jobs · Jobtensor · Built In (LA/SF/NYC)
  · Otta · Dice. **Design:** Dribbble · Behance · Coroflot · UX Jobs Board · Authentic Jobs
  · Designer News · The Brand Identity · It's Nice That · If You Could · Creative Boom ·
  Design Jobs Board · Working Not Working · AIGA · Motionographer · Dezeen · IDSA · Upwork ·
  DesignCrowd. **Game:** Hitmarker · Work With Indies · ArtStation · GamesIndustry.biz ·
  Remote Game Jobs · 8Bit.
- `source_priority = 4`. An ATS URL always beats a scraped one for `canonical_url`.
- Record the `robots.txt` allowance per host *with the date checked*, in-repo.

**Hard exclusions — these stay manual, permanently.** LinkedIn, Indeed, Glassdoor,
ZipRecruiter (ToS + bot detection) and Handshake (school SSO, no public API). Do not wire
them under any circumstance, including "just for testing."

**Gate.**
- A liveness table in-repo: host · alive? · robots allowance · date checked. Dead hosts are
  recorded as dead, not silently dropped.
- Any host whose `robots.txt` disallows the jobs path is **not wired**, and its absence is
  recorded with the reason.
- Rate limiting verified per host.
- Zero requests to any of the five excluded domains — asserted by grepping the run log.
- Re-run the Phase 6 zero-duplicates query with Tier 3 included → still zero.

**Rollback.** Revert. Nothing depends on Tier 3.

---
## 4. Acceptance traceability

Every acceptance criterion maps to a specific gate. None is left to "we'll see."

| Acceptance criterion | Verified by | Phase |
| --- | --- | --- |
| Zero cross-source duplicates in a real multi-source run | Two `GROUP BY … HAVING COUNT(*) > 1` queries returning zero rows, plus ≥5 postings carrying ≥3 sources (proving merges happened, not just non-overlap) | **P6** gate, re-run at **P11** |
| Every apply link resolves to a live posting | `npm run linkcheck` over the full DB, with ATS "no longer available" body markers checked, not just HTTP status | **P9** gate |
| No senior/staff/principal/lead roles present | 100% hard-drop recall on a 15-posting labeled subset (P4), then re-asserted across every filter combination including all-cleared (P8) | **P4** + **P8** gates |
| Both tabs sort exactly as specced | Fixtures constructed so a naive sort fails: Design's 24h-bucket-outranks-geo case, and Engineering's no-geo-weighting assertion | **P8** gate |
| Enrichment cost per full re-poll ~$0 | Re-run over 50 cached postings makes zero API calls; unchanged-corpus re-poll logs $0.00 | **P4** + **P10** gates |

---

## 5. Adversarial review findings

I ran this pass myself rather than delegating it — this session is configured not to spawn
subagents. Findings are ordered by severity, letters are stable IDs referenced from the
phases above.

### Critical — each one threatens a stated acceptance criterion

**I. The remote-vs-city dedupe hole. This one needs your call.**
`dedupe_key = sha256(company|title|location)` puts location in the key, which is correct —
the same company hiring the same role in SF and NYC really is two jobs. But the identical
posting listed as "San Francisco" on Greenhouse and "Remote" on RemoteOK produces two
different keys and will **not** merge. The near-dupe pass doesn't catch it either, because
that pass requires *same company + location* before it even looks at the title.

This is the single most likely way "zero cross-source duplicates" fails in a real run, and
it fails silently.

*Recommended resolution:* a third merge pass, after the near-dupe pass — same
`company_norm` + title token-set ratio ≥ 0.95 (tighter than the near-dupe threshold, since
we're dropping the location guard) **and** exactly one side has `is_remote = true`. Merge,
and keep the ATS source's location as truth. Higher ratio and the remote-XOR condition
together keep the false-merge risk low.

*Alternative if you'd rather not risk false merges:* leave it, and accept that some
remote/onsite pairs show twice. Cheaper, but it costs you the acceptance criterion.

**B. The enrichment cache key must hash normalized text, or the ~$0 re-poll doesn't happen.**
`sha256(description)` over the raw body will miss on trivial churn — Greenhouse re-escapes
HTML, aggregators reflow whitespace, and the three ATS families return three different
shapes for the same job (Greenhouse: escaped HTML; Lever: `descriptionPlain` plus a
separate `lists[]` array; Ashby: markdown). Hash `normalizeDescription(body)` instead —
tags stripped, entities decoded, whitespace collapsed. Built into P1 and asserted by P4's
whitespace-churn test.

**C. Ghost detection must only count absences from *successful* polls.**
"Absent from its source for 2 consecutive polls" read literally means a source that 500s
twice delists everything it ever provided. That's a mass false-delist from one bad
afternoon. Absence counts only when that source's `connector_runs` row is `ok` — which is
why `connector_runs` is in the schema from P1 rather than added later as an ops nicety.
P1 and P10 both carry an explicit negative test for it.

**A. HN "Who is Hiring" has no structured company field.**
Its entries are freeform comment text, so company extraction is genuinely hard — and
company is one of the three dedupe key components. Bad extraction produces phantom
non-merges against the ATS rows for the same job, directly against the P6 acceptance gate.
A regex will not do this reliably. One Haiku extraction call per comment, cached on the
comment hash like every other enrichment, is the right cost/quality trade. P6 gates on a
20-sample hand-verification at ≥18 correct.

### Important — wrong behavior, not a failed criterion

**D. `posted_at = MIN` lets a lying aggregator age out a live posting.**
An aggregator that reports a fabricated older date drags the merged `posted_at` back, and
with the 60-day cutoff that can hide a posting that is genuinely live on the ATS. Floor the
MIN at the ATS source's date whenever an ATS source exists — the ATS is authoritative about
its own posting. Ordinary MIN behavior everywhere else, which is what you want for
aggregator-only postings.

**E. "Title token-set ratio ≥ 0.90" is ambiguous and will drift.**
Token-set ratio has several plausible definitions and an ad-hoc implementation will pick a
different one than the next person expects. Pin it in a docstring with worked examples, and
assert the *expected* value on boundary cases rather than recording whatever the
implementation happens to produce. "Product Designer" vs "Product Designer II" is the case
that matters — it sits close enough to the threshold that the definition decides it.

**H. HTTP 200 doesn't mean the posting is live.**
Several ATS platforms serve a 200 with a "this job is no longer available" body for expired
postings. A HEAD-only link checker will pass them and the acceptance criterion becomes
untrue while reporting green. P9's checker matches known gone-markers in the body for the
seven Tier-1 platforms; anything else is reported as unverifiable rather than assumed live.

### Spec gaps — small, but they need a decision recorded

**F. `entry` has no filter chip.** Classification produces entry | junior | mid | senior+,
both tabs offer junior/mid chips, and the sort rule says "entry/junior above mid" —
so `entry` exists in sort but has nowhere to be filtered. *Taken:* `entry` folds into the
`junior` chip. Sort still treats them as the spec describes.

**G. `paid = unknown` has undefined filter behavior.** The field is
true | false | unknown and the chips are paid/unpaid. *Taken:* `unknown` matches neither
chip, but remains visible whenever no paid filter is active. Hiding it by default would
silently drop most postings, since most don't state pay.

---

## 6. Anti-patterns — do not do these

- **Do not build connectors before P1 merges.** The spec says so explicitly and it's right:
  every connector writes through `dedupe_key`, and changing it afterward means reprocessing
  everything.
- **Do not add a third tab.** Voice AI is a badge inside Engineering. It is stated twice in
  the spec because it is the obvious wrong move.
- **Do not filter by geography during ingest.** Ingest is geo-agnostic; store every location.
  Geography affects ranking, on the Design tab, only.
- **Do not hardcode a city or a tier outside `lib/geo.ts`.** `GEO_TIER` is the single
  editable constant. A second copy is how the Design tab silently stops matching the spec.
- **Do not classify on the title for voice AI.** Titles are "Member of Technical Staff."
  Body only, weighted, with barge-in / endpointing / turn detection weighted highest.
- **Do not call the LLM for anything already cached.** Cache lookup precedes everything,
  including the regex prefilter's bookkeeping.
- **Do not scrape LinkedIn, Indeed, Glassdoor, ZipRecruiter, or Handshake.** Not for
  testing, not behind a flag. They stay manual.
- **Do not let one connector abort a run.** `Promise.allSettled`, one `connector_runs` row
  each, exit 0 when any succeeded.
- **Do not animate the table.** Rows re-sorting on a filter change is touched dozens of
  times a day; a FLIP animation there makes a hot path feel slow. Three animations total,
  and this isn't one of them.
- **Do not introduce cards, stat tiles, or a chart.** The spec says table, not graph. Cards
  are banned at this density by two of the loaded design skills and by `.impeccable.md`.

---

## 7. Plan mutation protocol

The plan is expected to change. Change it deliberately.

**Split** a phase when its PR exceeds ~400 changed lines or its gate grows more than 8
assertions. Number the halves `Pn-a` / `Pn-b`; both inherit the original gate, divided.

**Insert** a phase when a finding needs work that no existing gate covers. Give it a letter
suffix (`P3.5`) rather than renumbering — the branch names are already in git history.

**Skip** a phase only if its gate is provably satisfied by another phase's gate. Record
which one, in this file, in the same PR.

**Reorder** only within the P4/P5/P6/P7 parallel window. Everything else has a real data
dependency and reordering it will look like it works right up until the dedupe keys are wrong.

**Abandon** a phase by moving it to an "Abandoned" section at the bottom with the reason and
the date. P11 is the only phase already marked optional; the acceptance criteria are all
reachable without it.

**When a gate fails:** fix forward inside the same PR. Do not merge a phase with a failing
gate and a follow-up ticket — the next phase's context brief assumes the previous gate held,
and the whole cold-start property of this plan depends on that being true.
