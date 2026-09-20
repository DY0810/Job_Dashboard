# Workie Auto Apply Implementation Plan

Planning date: September 20, 2026.
Status: documentation discovery and planning only; implementation has not started.
Baseline: `a68c3fadeca161c6d44ca337ba073ffea50a9e13` on `main`.
Root: `/Users/dyl/Workie`; `/Users/dyl/Job_Dashboard` resolves to this directory.

## Scope And Execution Contract

The latest request explicitly invokes `claude-mem:make-plan`. This document plans
the complete feature described in [HANDOFF.md](/Users/dyl/Workie/HANDOFF.md:1);
it does not implement or enable applications. The supplied attachment and the
existing, untracked `HANDOFF.md` were identical at inspection. Preserve both.

The eventual outcome is a real unattended application flow after one explicit,
versioned enablement: discover matching unprocessed jobs, screen official
requirements, tailor verified documents, fill forms, submit, and retain exact-role
receipt evidence. Unknown required information goes to a private answer inbox.
Answering resumes only eligible waiting applications; other work continues.

Implementation rules:

- Read this plan, the handoff, and current source before each phase. Preserve WIP.
- Do not mistake `/Users/dyl/Workie/app/auto-apply.tsx` or
  `/Users/dyl/Workie/lib/auto-apply.ts` for application execution. They apply filters.
- No production ingestion, mirror, email, account creation, model inference,
  deployment, or employer submission is authorized by this planning pass.
- Keep the GitHub Actions collector as the sole **corpus** writer. The new control
  plane owns a separate private application database.
- Never scrape LinkedIn, Indeed, Glassdoor, ZipRecruiter, or Handshake. Preserve
  robots, source attribution, rate limits, and independent connector failures.
- Never call `send_message_to_thread`, `codex_app.send_message_to_thread`, or
  `mcp__codex_app.send_message_to_thread`, including wrappers. Include this rule
  in every assignment. Use native subagent completion/wait or handoff files.
- Never import real applicant histories into fixtures, copy credentials from
  conversations, or mutate the original resume scripts/masters.
- A phase ends with its focused checks and a recorded result, not a claim based
  on code inspection. Fixtures, live reads, and live submissions are separate proof.

## Phase 0: Documentation Discovery

### Findings

Read-only discovery was divided into repository data/execution, UI/tests, resume
tooling, ATS/browser contracts, and provider contracts. Reports must identify
sources, actual APIs, copy-ready locations, and confidence/gaps. The plan author
retains architecture and phase synthesis.

Confirmed repository facts:

1. Local HEAD and the remote `main` ref both matched the baseline. No remote
   `staging` ref was returned. Only `HANDOFF.md` was untracked before this plan.
2. The lockfile resolves Next 15.5.25, React 19.1.0, Drizzle ORM 0.45.2,
   Drizzle Kit 0.31.10, libSQL client 0.17.4, better-sqlite3 13.0.3,
   Zod 4.4.3, and Vitest 4.1.10. CI uses Node 22. [R1, R11]
3. Applicant auth, a private question store, an application runner, and LLM
   transport do not exist. Applied flags are browser-local, numeric-ID marks,
   not employer receipts. Outreach and Talkie have different security models. [R3, R4]
4. Public results use a 200-row page and fetch 201 rows for the next-page
   sentinel. Their offset pagination is not a frozen application target list.
   Public visibility includes a 60-day limit and track/geography restrictions. [R2]
5. `ReadDb` is a sync/async union; `driver()` is only a type cast. Awaiting
   statements works, but an async transaction callback cannot be passed to the
   synchronous better-sqlite3 transaction implementation. [R5]
6. Mirror/pull use three explicit corpus tables, but Actions caches the whole
   `workie.db` file. Merely leaving new tables out of `TABLES` does not protect
   private rows from a cache upload or replacement. Mirror batches are not one
   atomic corpus snapshot. [R6]
7. The current refresh queue offers guarded updates, not application leases,
   heartbeats, external idempotency, or applicant identity. Its unique active
   request constraint is global and must not become an application bottleneck. [R7]
8. The collector HTTP helper retries 429/5xx responses for any method and retains
   request data across its guarded redirects. `publicOnly` is opt-in, DNS
   rebinding is not fully prevented, and JSON parsing is not Zod validation.
   Do not use this transport for application submission or provider secrets. [R8]
9. Public `/` and posting-detail responses have explicit CDN caching. Private
   bell counts or application data must not enter those cached responses. [R9]
10. Existing UI tests mostly inspect source or pure helpers. There is no
    configured real-browser application/worker test harness. [R10, R11]
11. Historical PDF editors provide useful measured-edit checks, but support a
    narrow, hardcoded template. They do not establish a portable editable-source
    adapter. Their old URI, punctuation, and scratch-file checks need correction. [R12]

### Local Source Ledger

Read the stated sections before copying a pattern. Line references describe the
baseline; re-find named symbols if implementation has moved them.

| ID | Sources And Copy-Ready Sections |
| --- | --- |
| R1 | [README.md:22](/Users/dyl/Workie/README.md:22), lines 22-71 and 267-288: writer/scheduler ownership and direct-main release policy. [package.json:1](/Users/dyl/Workie/package.json:1) and `/Users/dyl/Workie/package-lock.json`: runtime and locked dependencies. |
| R2 | [query.ts:148](/Users/dyl/Workie/lib/query.ts:148), lines 148-233: `structural`, `visible`, `userFilters`, `where`, `listPostings`; lines 270-300: public detail projection. [params.ts:172](/Users/dyl/Workie/lib/params.ts:172), lines 172-353: parsing, vocabulary and URL helpers. [query.test.ts:827](/Users/dyl/Workie/lib/query.test.ts:827), lines 827-897: pagination regressions. |
| R3 | [board-storage.ts:1](/Users/dyl/Workie/app/board-storage.ts:1), [applied-checkbox.tsx:18](/Users/dyl/Workie/app/applied-checkbox.tsx:18), [board-storage.test.ts:21](/Users/dyl/Workie/app/board-storage.test.ts:21): manual marks/defaults, failure behavior, storage events. [outreach-storage.ts:35](/Users/dyl/Workie/app/outreach-storage.ts:35): separate sender profile. |
| R4 | [write-gate.ts:19](/Users/dyl/Workie/lib/write-gate.ts:19), lines 19-64: shared-token gates, not identity. [autosave.ts:1](/Users/dyl/Workie/app/talkie/autosave.ts:1), [autosave.test.ts:34](/Users/dyl/Workie/app/talkie/autosave.test.ts:34): acknowledgement-aware writes. [talkie-badge.tsx:1](/Users/dyl/Workie/app/talkie-badge.tsx:1): badge presentation only. |
| R5 | [index.ts:12](/Users/dyl/Workie/lib/db/index.ts:12), lines 12-38, 68-118: driver contracts. [turso.test.ts:1](/Users/dyl/Workie/lib/db/turso.test.ts:1): local libSQL tests. [schema.ts:1](/Users/dyl/Workie/lib/db/schema.ts:1), [drizzle.config.ts:1](/Users/dyl/Workie/drizzle.config.ts:1), `/Users/dyl/Workie/drizzle/meta/_journal.json`: schema/migration conventions. |
| R6 | [push-remote.ts:42](/Users/dyl/Workie/scripts/push-remote.ts:42), lines 42-44 and 196-221: table allowlist and destructive mirror semantics. [pull-remote.ts:93](/Users/dyl/Workie/scripts/pull-remote.ts:93), lines 93-148: atomic publication/cache replacement. [refresh.yml:1](/Users/dyl/Workie/.github/workflows/refresh.yml:1): actual cached paths and writer environment. |
| R7 | [refresh-queue.ts:37](/Users/dyl/Workie/lib/refresh-queue.ts:37), lines 37-94: conflict/read/CAS patterns. [refresh-queue.test.ts:111](/Users/dyl/Workie/lib/refresh-queue.test.ts:111): stale completion. [notes.ts:136](/Users/dyl/Workie/lib/notes.ts:136), lines 136-162: retry-safe inserts, not private ownership. |
| R8 | [runtime.ts:345](/Users/dyl/Workie/lib/runtime.ts:345), lines 345-524: robots, redirects, retries, public-destination checks. [runtime.test.ts:312](/Users/dyl/Workie/lib/runtime.test.ts:312): relevant safety cases. [dedupe.ts:1](/Users/dyl/Workie/lib/dedupe.ts:1): `publisherIdOf` and normalization. [ingest.ts:457](/Users/dyl/Workie/scripts/ingest.ts:457), lines 457-547: publisher matching. |
| R9 | [next.config.ts:18](/Users/dyl/Workie/next.config.ts:18), lines 18-23: public cache rules. [layout.tsx:24](/Users/dyl/Workie/app/layout.tsx:24): layout. [page.tsx:362](/Users/dyl/Workie/app/page.tsx:362), [talkie/page.tsx:37](/Users/dyl/Workie/app/talkie/page.tsx:37): separate headers. [drawer.tsx:125](/Users/dyl/Workie/app/drawer.tsx:125), lines 125-141 and 238-327: dialog/manual actions/labeled forms. |
| R10 | [.impeccable.md:53](/Users/dyl/Workie/.impeccable.md:53), including amendments near line 144. [globals.css:167](/Users/dyl/Workie/app/globals.css:167), [icons.tsx:1](/Users/dyl/Workie/app/icons.tsx:1), [layout.test.ts:21](/Users/dyl/Workie/lib/layout.test.ts:21), [outreach-forms.test.ts:4](/Users/dyl/Workie/app/outreach-forms.test.ts:4): visual conventions and current verification limits. |
| R11 | [verify.yml:15](/Users/dyl/Workie/.github/workflows/verify.yml:15), lines 15-23: actual CI commands. [vitest.config.ts:1](/Users/dyl/Workie/vitest.config.ts:1). [auto-apply.ts:60](/Users/dyl/Workie/lib/auto-apply.ts:60), [auto-apply.test.ts:31](/Users/dyl/Workie/lib/auto-apply.test.ts:31): accessible filter behavior to preserve. |
| R12 | [tailoring skill:34](/Users/dyl/.agents/skills/tailor-resume/SKILL.md:34), [baseline-tailoring.md:123](/Users/dyl/.agents/skills/tailor-resume/references/baseline-tailoring.md:123). [fixed_editor_v2.py:171](/Users/dyl/Internships/_system/zero-day-2026-09-18/fixed_editor_v2.py:171), lines 171-345: bounded edits, output, pixel/text/font checks. [fixed_editor_v3.py:47](/Users/dyl/Internships/_system/zero-day-2026-09-18/fixed_editor_v3.py:47), lines 47-160: font/map checks. [verify_pdf.py:20](/Users/dyl/.agents/skills/tailor-resume/scripts/verify_pdf.py:20), [compare_to_master.py:31](/Users/dyl/.agents/skills/tailor-resume/scripts/compare_to_master.py:31): diagnostic defects, not production validators. |

### External Documentation And Allowed APIs

These are documented interfaces, not evidence of installed integrations or
permission to call an employer. Recheck the pinned documentation at implementation.
Where web extraction was empty, official raw documentation was read directly.

| ID | Documentation Read / Contract |
| --- | --- |
| D1 | Better Auth 1.7.5 documentation source under `https://github.com/better-auth/better-auth/tree/v1.7.5/docs/content/docs`: `adapters/drizzle.mdx`, `integrations/next.mdx`, `authentication/email-password.mdx`, `concepts/session-management.mdx`, `concepts/hooks.mdx`, `concepts/rate-limit.mdx`. `betterAuth`, `drizzleAdapter` from `@better-auth/drizzle-adapter`, `toNextJsHandler` from `better-auth/next-js`, `createAuthClient` from `better-auth/react`, and `auth.api.getSession({ headers })` are the selected interfaces. |
| D2 | Same Better Auth sources: `emailAndPassword.requireEmailVerification`, `revokeSessionsOnPasswordReset`, `emailVerification.sendVerificationEmail`, `emailAndPassword.sendResetPassword`, `createAuthMiddleware`, database-backed `rateLimit`, session revocation. Cookie existence is not authentication; server-side `auth.api` calls do not inherit HTTP rate limiting. The device plugin was inspected but is not needed for the narrower pairing protocol below. |
| D3 | `https://vercel.com/docs/vercel-blob/private-storage`, `https://vercel.com/docs/vercel-blob/client-upload`, and `https://vercel.com/docs/vercel-blob/using-blob-sdk`: `put`, `get`, `upload`, `handleUpload`; private access, authorization inside `onBeforeGenerateToken`, upload limits, verified completion callbacks. `handleUpload` needs its read/write signing credential; do not assume OIDC alone covers it. |
| D4 | `https://github.com/Brooooooklyn/keyring-node`: `Entry(service, account)`, `setPassword`, `getPassword`, `deletePassword`. Do not copy its example logging the password. Require persistent Secret Service on Linux; the fallback in-memory keyring does not survive reboot. Node 22 `fetch`, `AbortController`, `AbortSignal.timeout`/`any`, `crypto.randomBytes`, hashing, and AES-GCM are standard primitives. |
| D5 | OmniRoute v3.8.50: `https://github.com/diegosouzapw/OmniRoute/blob/v3.8.50/docs/reference/API_REFERENCE.md`, `docs/openapi.yaml`, `docs/guides/COST_TRACKING.md`, and `src/app/api/v1/models/catalog.ts`. Documented reads: `GET /v1/models?prefix=alias`; generation: `POST /v1/chat/completions`. Catalog presence or zero reported cost does not prove a free route. Management access is not part of ordinary worker access. |
| D6 | `https://docs.ollama.com/capabilities/structured-outputs` and `https://docs.ollama.com/api/openai-compatibility`: native `POST /api/chat` with schema in `format`; compatible `POST /v1/chat/completions` with negotiated `response_format`; `GET /v1/models`. These are different request dialects. Localhost may still route a cloud model; verify actual locality. |
| D7 | `https://playwright.dev/docs/auth`, `https://playwright.dev/docs/locators`, `https://playwright.dev/docs/input`, `https://playwright.dev/docs/frames`, `https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context`, and `https://playwright.dev/docs/api/class-browsercontext#browser-context-storage-state`: persistent application-owned contexts, locators, upload/frame handling and session safety. Selected call shapes appear below. |
| D8 | `https://help.libreoffice.org/latest/en-US/text/shared/guide/start_parameters.html`: `--headless`, `--convert-to pdf:writer_pdf_Export`, `--outdir`, and `-env:UserInstallation=...`. These document conversion, not exact-format fidelity. Python `zipfile`/XML and pypdf public reader/writer interfaces are the starting points for editable-source and fixed-PDF work. |
| D9 | Pinned Jev source: `https://github.com/browser-use/jev-ultrafast/tree/1231850a0bf1a0c0341fe408ef1668dbbfdfac46`, especially `jev_ultrafast/model.py` and README evidence/limits. `https://docs.typesafe.ai/models` and `https://docs.typesafe.ai/legal`: optional hosted decision service, not free/local inference or a complete ATS runner. |
| D10 | `https://nextjs.org/docs/app/guides/authentication`: server-side data access authorization and narrow data transfer. `https://vercel.com/docs/functions/limitations`: request limits; large document bytes must not be relayed through an ordinary serverless form request. |

Selected new packages are Better Auth plus its Drizzle adapter, Playwright plus
its test runner, private Blob SDK, and a worker-only OS-keychain binding. Reuse
existing Zod, Drizzle/libSQL, native fetch, and SMTP transport configuration.
Use existing icons when applicable; add tree-shaken Lucide controls for missing
bell/run icons rather than drawing a new icon set.

Registry metadata checked during planning reports Better Auth and its Drizzle
adapter at 1.7.5; their declared peers include this checkout's Next, React,
Drizzle ORM and Drizzle Kit versions. That is metadata compatibility, not a
passing integration test. Pin compatible, security-reviewed versions when coding;
do not use `--force`, install an unneeded Drizzle major, or blindly copy `@latest`.

PDF prerequisites are worker-local Python, pypdf, pdfplumber, Pillow, Poppler,
and LibreOffice for the editable DOCX path. Record actual versions and license
notices before packaging; fonts and historical scripts need their own rights
review. Do not add an AGPL library incidentally or claim all tools are permissive.

### Discovery Verification

- [x] Read the full brief and preserved handoff; verified current root/ref/WIP.
- [x] Identified actual repository APIs, transaction/cache traps, and UI test gaps.
- [x] Read auth, private storage, keychain, provider, resume, and conversion contracts.
- [x] Consolidated the ATS/browser documentation report into the support matrix.
- [x] Validated 13 phases, 48 local source links, acceptance coverage, scan syntax and whitespace.

No runtime capability, existing test pass count, live provider entitlement, or
employer receipt is asserted by this discovery.

## Architecture Decisions

### Keep The Existing Stack, Separate Its Responsibilities

| Component | Selected Responsibility |
| --- | --- |
| Existing GitHub Actions collector | Write the public corpus and its existing Turso mirror only. No applicant data, browser sessions, private credentials, or application execution in its cache. |
| Next.js control plane | Authenticated profiles, policy, documents, durable queue, questions, state transitions, cost reservations, and receipt metadata. Public browsing stays public. |
| Private database | Separate local SQLite file or separately configured Turso database, using existing Drizzle/libSQL. Separate schema and migration directory; never `workie.db`. |
| Application worker | A paired, revocable Node 22 process. Outbound HTTPS polling; local browser sessions and document rendering; local or permitted remote inference. No corpus write access. |
| Document storage | Local private filesystem for fully local development; private Blob store for hosted operation. The worker downloads only authorized artifacts into private per-attempt directories. |
| Browser | Playwright-controlled, dedicated applicant/tenant profiles. Not the user's everyday Chrome profile, Codex browser, chat session, or a public remote-debugging port. |

Use async libSQL for the **new private database in both local and hosted modes**,
so its transaction contract is one real async API. Leave existing corpus
better-sqlite3 writes and shared read behavior alone. A separate database avoids
the whole-file corpus-cache hazard without introducing another database engine.

Hosted profile/document storage is cloud storage even when inference is local.
Label the setting **local inference only**, not a claim that all data remains
offline. A policy prohibiting cloud storage requires the fully local control
plane/storage configuration. Never upgrade either policy through fallback.

Closing the Workie page does not stop the worker. A sleeping/disconnected worker
does stop processing. Show last heartbeat and paused discovery/execution honestly;
perform full unprocessed reconciliation when it returns. An always-on host can
run the same worker, but is not provisioned or promised in this plan.

### Ownership And Immutable Records

Use one authenticated user as the owner of every private row. Require ownership
in the data-access operation, including joins, downloads, retries, and counts.
Never trust a client-provided `ownerId`. Worker credentials are narrower
capabilities, not browser sessions and not shared Talkie/send tokens.

The following are logical records to implement as needed, not a reason to create
one repository/service class per record:

| Record | Required Fields / Constraints |
| --- | --- |
| Auth-generated tables | Library-generated users, accounts, sessions, verification and database rate-limit state, in the private database only. |
| Profile versions | Unique `(ownerId, revision)`; validated section JSON with stable entity/fact IDs, provenance, precision, confirmation state and current/past scope. Immutable versions; optimistic-concurrency head check. |
| Answer versions | Immutable scoped answers with semantic/schema fingerprint, exact type/options/units, provenance, confirmed timestamp and revision. User facts outrank imported/model candidates. |
| Documents | Owner, kind, immutable object key, master/version/parent reference, byte hash, MIME/size, validated/quarantined state, edit manifest and separate QA results. Masters and sent artifacts never overwritten. |
| Provider settings/usage | Versioned endpoint/model/capability/privacy/cost policy and secret reference; per-request reservations and usage keyed by idempotency key. Unknown cost is nullable, not zero. |
| Pairings/workers | Server-bound owner, hashed one-time grant or worker token, expiry/revocation, capabilities, heartbeat, assigned profile identity and credential version. |
| Policy versions/runs | Accepted policy version/hash/time; saved strict filters, source/country restrictions, limits, status, scan clock and continuation state. Policy expansion needs owner action. |
| Run targets | Immutable captured target identity/source snapshot and disposition for a run, including duplicates/blocked/held-by-cap outcomes. Unique `(runId, targetKey)`. |
| Applications/attempts | Unique logical application `(ownerId, ATS, tenant, requisition)`; attempts/checkpoints, lease owner/expiry/fence, policy/fact/document versions, submission intent and receipt references. Reapplication is a separately authorized attempt, not a fresh duplicate row. |
| Questions/waiters | Owner-scoped question fingerprint and exact original schema; a wait relation for each application/field. Reading does not resolve. Unknown-document/login/verification/policy/provider states stay distinguishable. |
| Application events | Append-only, bounded/redacted state changes and evidence references with unique event keys. Derive inbox notifications/unread markers here instead of adding a separate messaging platform. |

JSON schemas need explicit versions and migrations. Add SQL uniqueness, foreign
keys, and CHECK constraints for correctness-critical values; TypeScript unions
alone are not database constraints. Private references must be owner-consistent.
Do not add a cascade/restrict FK from receipts or applications to mutable corpus
postings. An optional posting ID is a non-authoritative lookup hint only.

### State And Submission Safety

The proposed state machine has the following transitions. Implement this table
as tested pure transition logic plus guarded persistence, not scattered UI flags.

| State | Permitted Next Step |
| --- | --- |
| `queued` | `screening` after an owner-scoped atomic claim. |
| `screening` | `tailoring`, a typed blocking state, or `skipped` with evidence. |
| `tailoring` | `filling` only with a verified immutable artifact; otherwise a typed block or bounded failure. |
| `filling` | `ready` only after required fields, conditional steps and parsed uploads reconcile to confirmed facts. |
| `needs_answer`, `needs_document`, `needs_policy_decision` | Resume the saved logical step only after a matching, version-checked resolution. |
| `needs_login`, `needs_verification` | Resume after the paired browser observes actual successful intervention, not after clicking the notification. |
| `provider_unavailable`, `retryable_failure` | Retry the safe stage after bounded backoff/config repair; no implicit new spending or unsafe submission replay. |
| `blocked_unsupported` | Stay blocked with precise adapter/control reason; require supported code or owner-controlled manual completion. |
| `ready` | Automatically acquire a fresh submit permit and persist `submitting` when enabled and all guards pass. No routine confirmation modal. |
| `submitting` | `submitted` with exact-role evidence; `filling` only for an authoritative validation rejection; otherwise `submission_unknown`. |
| `submission_unknown` | Read-only reconciliation. `submitted` on matching receipt; a new submit attempt only after authoritative proof of non-submission and a fresh safety check. |
| `submitted` | Immutable receipt/manifest. Never return to the queue automatically. |
| `failed`, `skipped`, `cancelled` | Terminal for that attempt; deliberate reconsideration must preserve history and pass duplicate/policy checks. |

Run pause/resume/stop is separate from the application's blocking reason.
Pause releases safe-stage work without losing checkpoints; waiting work releases
the execution slot. Cancellation after submission is not an undo or withdrawal.

Use a proposed 120-second lease with 20-second heartbeats, measured against
server time and a conservative local monotonic deadline. These are starting
constants, not an ATS promise. Every claim, checkpoint, answer resolution,
artifact attachment and submit permit checks an incrementing fence and revision.
Every awaited boundary before a browser mutation rechecks local validity.

The irreversible path is:

1. Reinspect official role/form, resolved destination, current policy/stop state,
   facts, conditions, attachment hashes, remaining caps and unresolved questions.
2. Atomically validate owner/worker/fence and persist submission intent plus the
   exact answer/document manifest. Move to `submitting` before the browser action.
3. Execute one authorized submit action with automatic POST retries disabled.
4. Verify exact-role receipt; persist an idempotent evidence event.
5. On lost response, browser death, timeout, or lease expiry after intent,
   use `submission_unknown`. A replacement worker may reconcile, not blindly click.

An application in `submitting`/`submission_unknown` cannot be reassigned to a
fresh submission. A late worker cannot overwrite a newer result. Lost checkpoint
acknowledgements reuse event keys; they do not replay external actions.
There is no general exactly-once guarantee at an ATS lacking idempotent submission.
Likewise emergency stop cannot retract an external request already in flight.

### Proposed API Boundaries

These routes are new Workie contracts to build, not methods asserted to exist:

| Boundary | Proposed Routes / Authentication |
| --- | --- |
| Identity | `/api/auth/[...all]`, library handlers; protected pages and DAL verify the actual server session. |
| Profile/documents | `/api/profile`, `/api/documents`, `/api/documents/uploads`, `/api/documents/[id]/download`; browser session plus ownership. Signed upload callbacks are verified by the storage SDK and bound to a server-created upload grant. |
| Settings/runs | `/api/providers`, `/api/auto-apply/policies`, `/api/application-runs`, `/api/application-runs/[id]/actions`; strict versioned command schemas and idempotency keys. |
| Applications/inbox | `/api/applications`, `/api/applications/[id]`, `/api/inbox`, `/api/questions/[id]/answer`; private, paginated, no-store. Mark-read is a distinct mutation. |
| Pairing | `/api/workers/pairings` requires browser auth; `/api/worker/pair` consumes only its high-entropy, expiring one-time grant. |
| Execution | `/api/worker/poll`, `/api/worker/heartbeat`, `/api/worker/applications/[id]/events`, `/api/worker/applications/[id]/submit-intent`; worker capability, owner, active assignment, fence and event-key validation. |

Private routes use `Cache-Control: private, no-store`, no CDN shared caching,
strict same-origin protection for cookie-authenticated mutations, bounded body
sizes, and per-principal rate limits. Signed upload callbacks are not rejected
for lacking a browser cookie; authorize the token-issuing branch and validate
the callback signature/recorded grant in the completion branch.

## Phase 1: Private Storage And Applicant Authentication

Depends on: Phase 0. No UI or worker may handle private production data before this gate.

**Read first:** R1, R5, R6, R9; D1/D2 sections Drizzle example, Next route handler,
server-session checks, email verification, session revocation, and rate-limit storage.

**What to implement**

1. Copy the async libSQL setup pattern into
   `/Users/dyl/Workie/lib/private-db/index.ts`, with private schema in
   `/Users/dyl/Workie/lib/private-db/schema.ts` and migrations under
   `/Users/dyl/Workie/drizzle-private/`. Use a separate Drizzle config.
   Test transactions through real async libSQL locally and a test HTTP endpoint.
2. Require explicit private database configuration on Vercel. Refuse a private
   target resolving to the corpus database/file. No fallback to `getDb()` or
   silent `workie.db` creation. Fail private routes closed without breaking public jobs.
3. Copy Better Auth's handler/client/server-session patterns into
   `/Users/dyl/Workie/lib/auth.ts`, `/Users/dyl/Workie/lib/auth-client.ts`,
   `/Users/dyl/Workie/lib/applicant-access.ts` and the auth route.
   Keep private service initialization out of build-time unconfigured execution.
4. Implement email/password signup, sign-in/out, verification and password reset.
   Use a configured allowed-applicant list for this personal deployment; no
   hardcoded users. Verification/reset mail uses an explicitly configured sender
   and the existing SMTP configuration, not the public outreach send endpoint.
   Keep account-existence responses uniform and use a supported serverless
   completion mechanism; an untracked fire-and-forget mail promise is insufficient.
5. Copy documented database-backed auth rate limits and trusted-origin checks.
   Disable session-cookie caching for sensitive decisions. Password reset/security
   revocation also revokes paired worker credentials and pauses pending work.
6. Add owner-scoped data access and private response headers. Public headers
   remain intact; private UI on the public board must load client-side.

**Verification checklist**

- [ ] Fresh and upgrade private migrations succeed; all private-table constraints are active.
- [ ] Two independent users cannot read/write each other's rows, files or counts.
- [ ] Missing, forged, expired and revoked sessions fail locally and over HTTP.
- [ ] Cross-origin mutations, forged owner IDs and signup outside the configured scope fail.
- [ ] Password reset/session revocation tests use a synthetic mail sink.
- [ ] A scratch collector pull/push/cache cycle leaves the private database untouched;
      inspected cache archives contain no private data.
- [ ] Private missing configuration returns a clear unavailable state; public browsing works.

**Anti-pattern guards:** no local auth bypass, shared-token identity, cookie-presence-only
auth, async better-sqlite3 transactions, private tables added to corpus migrations,
or changes to the production collector/cron secrets.

## Phase 2: Versioned Profile, Policy And Secure Documents

Depends on: Phase 1.

**Read first:** R3/R4 acknowledgement/storage tests; R9 labeled form patterns;
HANDOFF sections Private Applicant Profile and Resume Tailoring; D3 private
downloads, client upload authorization, size constraints and completion callbacks.

**What to implement**

1. Add `/Users/dyl/Workie/app/profile/page.tsx` and typed schemas in
   `/Users/dyl/Workie/lib/applications/profile.ts`. Copy native labeled controls,
   not the three-field outreach profile or shared Talkie storage.
2. Implement all nine profile sections from the handoff: identity/contact;
   education; work/projects; country-specific authorization; availability;
   employer-scoped disclosures; separate optional voluntary answers; application
   preferences; documents/providers. Preserve repeated entries and date precision.
3. Represent each fact with value/state/type/units, scope/timeframe, provenance,
   confirmedAt and version. Use explicit `unknown`, `declined`, `not_applicable`
   states where valid. Imported/model candidates cannot become confirmed silently.
4. Adapt the serialized desired/acknowledged autosave pattern to structured
   revisions, including intentional clearing. Return conflicts instead of
   overwriting newer facts. Keep encrypted, per-principal recovery drafts with an
   authenticated key unlock; clear plaintext and in-flight work on principal change.
5. Add document upload grants, content/size/type checks, quarantine, immutable
   versioned storage, authenticated downloads, and per-owner quotas. Use private
   client-direct uploads when hosted, rather than a serverless multi-megabyte relay.
   Local storage uses generated IDs and restrictive permissions outside public assets.
6. Build the versioned enablement policy: actions/destinations/documents,
   disclosure rules, account policy, remote inference consent, fallback order,
   monetary limits, application caps, expiry/revocation and reapplication rules. Defaults: disabled,
   no new ATS accounts, zero paid-model allowance, no unapproved remote fallback.
   Setting a key or saving a profile is not enablement.

**Verification checklist**

- [ ] Every profile section round-trips; optional blanks do not block enablement.
- [ ] Citizenship differs from residence; expected graduation differs from completed
      education; current restrictions differ from historical agreements.
- [ ] Unacknowledged edits survive reload/network failure; later saves cannot be lost
      to an earlier response; another user cannot decrypt/recover the draft.
- [ ] Two uploads, duplicate callbacks, wrong MIME, oversized input, ZIP traversal,
      malformed PDF and unauthorized downloads behave safely.
- [ ] An incomplete upload never becomes a usable master; previous masters stay immutable.
- [ ] Policy changes produce a new version; no form save enables or broadens automation.

**Anti-pattern guards:** no stored provider key in browser storage, inferred EEO,
arbitrary filesystem paths, public document URLs, trusting client MIME/hash alone,
or required DOB where age eligibility is sufficient.

## Phase 3: Pairing And Durable Worker

Depends on: Phases 1-2.

**Read first:** R7 guarded-update and stale-completion tests; R5 transaction
limitations; D4 keychain API; D7 persistent-context security.

**What to implement**

1. Add `/Users/dyl/Workie/worker/main.ts` and
   `/Users/dyl/Workie/lib/applications/state.ts`. Implement the state/lease/event
   contracts above with injected clocks and a short worker poll loop.
2. Pair through a browser-authenticated grant bound to its owner. Generate
   cryptographically random grants/tokens, store only hashes server-side, expire
   unconsumed grants, and consume atomically. The worker generates and secures its
   credential before registering; a lost response can be reconciled without making
   another worker. Never place secrets in command arguments or URL parameters.
3. Store worker/provider credentials through the OS keychain. Scope names by
   control-plane origin, applicant and worker. Add heartbeat, revocation, protocol
   version, capabilities and a visible offline/unpaired state.
4. Poll outbound HTTPS only; no browser-tab loop, Vercel background promise,
   inbound public local port, or raw database credential on the worker.
   A paired host is trusted to act for that applicant, not other applicants.
5. Implement claim fences, stage checkpoints, bounded safe retries, process
   restart and host-sleep recovery. A blocked application releases its slot.
   Pin work to the selected runner/profile; transfer requires explicit pairing.
   Check affected-row counts: a stale, zero-row update is not an acknowledged
   checkpoint or permission to perform the next action.
6. Persist user controls and worker commands. Include pause/resume, skip,
   retry-safe failure, cancellation and emergency stop. Model output cannot issue them.
   Start with one active application per applicant/tenant; allow other work
   after a checkpointed block. Do not reuse the global refresh lock.

**Verification checklist**

- [ ] Expired/replayed pairing grants, wrong-owner approvals and stolen unrelated
      session/send tokens cannot pair or claim work.
- [ ] Two workers contend for one application; only one fence wins.
- [ ] Restart after every safe-stage checkpoint resumes once without duplicate events.
- [ ] Lease expiry, clock changes, revoked worker and lost heartbeat prevent further
      mutations; expired `submitting` work becomes unknown, not freshly queued.
- [ ] Closing the UI leaves a child-process fixture run active; stopping/sleeping
      the worker shows offline and preserves recoverable state.
- [ ] A waiting application does not hold a global execution slot.

**Anti-pattern guards:** no dependency on Codex `cua_repl` handles, timers in a
Next request, stateless browser-only queues, plaintext session-profile backups,
shared applicant browser directories, or claims of uninterrupted laptop processing.

## Phase 4: Complete Discovery, Stable Identity And Suppression

Depends on: Phases 1-3.

**Read first:** R2 `where`/`userFilters` and sentinel tests; R8 `publisherIdOf` and
ingest lookup; R3 manual applied marks; R6 non-atomic mirror behavior.

**What to implement**

1. Add strict run-filter validation in
   `/Users/dyl/Workie/lib/applications/discovery.ts`. Reuse existing vocabulary
   and parameterized predicate construction. Unlike permissive URL parsing, an
   invalid saved automation filter must fail rather than broaden to "any".
2. Separate reusable job filters from public-board presentation restrictions
   carefully: existing public results must remain unchanged. Auto Apply setup
   records the actual selected corpus scope, including country/track rules,
   and applies explicit applicant preferences. Do not claim discovery beyond
   the collected corpus or silently inherit a geography restriction as user intent.
3. Capture a compact, immutable set of candidate identities/source snapshots
   with one consistent corpus read and a fixed scan clock; do not loop the
   changing UI offset pages. Omit full descriptions from this selection and store
   the resulting manifest as an immutable private artifact with its hash before
   materializing claimable targets. No partial SELECT result is a completed scan.
   If the read exceeds a tested resource bound, fail the scan visibly rather
   than silently truncating at 200 or creating a partial runnable cohort.
4. Persist targets idempotently in chunks keyed by run/target identity. Incomplete
   staging cannot execute; restart either completes the same snapshot or
   explicitly abandons it before creating a replacement. A later scan catches
   arrivals after capture, including arrivals during non-atomic mirror batches.
5. Resolve employer/ATS tenant/native requisition from official sources before
   execution. Retain URL aliases and source evidence. Fuzzy title/company/location
   dedupe and numeric posting IDs are not submission identity.
6. Enqueue all distinct unprocessed matches once across overlapping runs.
   Daily limits defer queued work rather than discard targets. A standing enabled
   policy scans while its runner is available and reconciles the full unprocessed
   eligible set after downtime; expose any missed/expired-source limitations.
7. Offer an owner-confirmed preview/import of legacy applied flags, never automatic
   attribution to the signed-in user on a shared browser. Preserve unresolvable
   IDs as unresolved legacy records. Imported marks suppress duplicate application
   but stay `manual_reported`, distinct from verified receipts.

**Verification checklist**

- [ ] A synthetic corpus of 601 distinct matching requisitions plus duplicates
      captures all 601 exactly once, independent of UI pagination.
- [ ] Overlapping filters/runs, repeated scan commits and worker restarts do not enqueue twice.
- [ ] Concurrent corpus updates/merges/deletions cannot alter captured receipt identity
      or cause offset skips; new arrivals are picked up by reconciliation.
- [ ] Paid, unpaid and unknown remain distinct; ambiguous currency/period is not converted.
- [ ] Caps retain the backlog; cooldowns and deliberate reapplication are enforced.
- [ ] Legacy imports require ownership confirmation and never turn into receipts
      or disappear from the original browser before acknowledged import.

**Anti-pattern guards:** no `listPostings(...page=1)` as the application universe,
no advancing a cursor before commit, no ID-only application uniqueness,
no second collector, and no hidden broadening on malformed filters.

## Phase 5: Private Question Bell And Automatic Resume

Depends on: Phases 1-4.

**Read first:** R4 autosave acknowledgements and existing badge limitations;
R9 separate public headers/cache rules; HANDOFF Notification Bell section.

**What to implement**

1. Add `/Users/dyl/Workie/lib/applications/questions.ts`,
   `/Users/dyl/Workie/app/notification-bell.tsx` and a private inbox. Copy
   dialog/focus patterns, but not shared notes or error-as-zero badge behavior.
2. Add typed questions with exact wording/options/requiredness/validation,
   employer/requisition, unresolved reason and waiting count. Distinguish all
   blocking kinds from ordinary submitted/failed notifications.
3. Fingerprint equivalence using reviewed meaning ID, scope/timeframe, type,
   units, options/validators and schema version. LLM similarity proposes
   candidates only; it cannot equate legal or eligibility questions.
4. Support text, textarea, radio/select, precise dates, numbers/units and uploads.
   Offer application-only, employer-only and verified-equivalent reuse scopes.
   Decline/skip is available only when permitted by question and policy.
5. In one private-database transaction, validate expected question/fact revisions,
   write the immutable answer, resolve matching waiters, and schedule only
   eligible unsent work with an idempotent resume event. Multiple blockers
   must all be cleared before a job runs.
6. Reuse encrypted draft recovery from Phase 2; same-principal session refresh
   retains work, actual account change clears plaintext. Use bounded polling
   with backoff/visibility handling, distinct unread/unresolved counts,
   keyboard focus return and truthful loading/offline/error states.
7. Human-verification/login items request a focus command for the correct
   paired browser, not an attempt to automate MFA/CAPTCHA inside Workie's bell.
   Normal factual questions are fully answerable inside Workie.

**Verification checklist**

- [ ] Answer, reload, reconnect and repeated answer submission resume the correct
      application once; unrelated applicants/employers/wordings remain blocked.
- [ ] One question can release multiple equivalent waiters; another blocker prevents premature resume.
- [ ] Reading/marking a notification read does not answer or resolve it.
- [ ] Modified options, stale schema, changed precision or policy invalidate stale reuse.
- [ ] Unknown optional fields are left blank/declined according to policy, not needlessly asked.
- [ ] Bell works on public jobs, private pages and Talkie without caching private data.

**Anti-pattern guards:** no global answer defaults, semantic-similarity-only
dedupe, loss of unanswered drafts, shared Talkie questions, or resume on a mere click.

## Phase 6: Provider Contract, Privacy And Cost Controls

Depends on: Phases 1-5.

**Read first:** D4-D6 exact endpoint/capability contracts; R8 transport caveats.
Recheck official OmniRoute route information without changing the personal service.

**What to implement**

1. Add one small structured-generation contract in
   `/Users/dyl/Workie/worker/providers.ts`. Tasks are tailoring edits, question
   classification and constrained form interpretation. Use native fetch plus
   existing Zod, not a multi-agent/LLM workflow framework.
2. Support OmniRoute-compatible, local Ollama/native-compatible and BYOK endpoint/
   model settings. Negotiate schema-constrained, JSON-only or bounded parse/repair
   output modes; record them distinctly. Validate the HTTP envelope, refusals,
   truncation, content JSON and domain schema. Reject unexpected tool calls.
3. Provide capability/connection checks using synthetic input, only after the
   owner selects a provider and permits the test. Record version/model/resolved
   route, locality, context/output bounds and verification time.
   No key was supplied with the brief; unconfigured is a normal actionable state.
4. Configure local worker keys through masked local entry into its OS keychain.
   Hosted secret entry, when selected, uses a server-side encrypted credential
   envelope with authenticated owner/config binding and rotation metadata.
   Use a fresh nonce and authenticated owner/provider/purpose metadata for each
   envelope; never reuse the auth session secret as its encryption key.
   UI reads return reference/masked status only. No keys in URLs, localStorage,
   logs, traces or job/model context.
5. Separate approved provider endpoints from untrusted job URLs. Allow loopback
   inference only on the paired worker under explicit configuration. Prevent
   cross-origin secret forwarding on redirects; verify underlying local/cloud
   execution and fallback destinations, not just the hostname.
6. Add atomic request/run/day budget reservations before every chargeable
   dispatch, including repair/retries. Use integer currency units and a fixed
   day boundary. Unknown pricing/usage is not zero; retain a conservative
   reservation after an uncertain billed request.
7. Require trusted pricing and enforced input/output limits for zero-cost or
   paid budgets. Record estimated versus provider-reported usage distinctly.
   OmniRoute may report zero for an unpriced route; do not treat it as proof.
   A fallback may run only within the saved destination/privacy/budget policy.
8. Bound timeouts, output/body size, attempts, concurrency and cooldowns.
   Authentication, quota, price or capability failures become `provider_unavailable`
   with an actionable reason; other eligible applications/providers continue.

**Verification checklist**

- [ ] Local/native, compatible and BYOK mock servers pass one task/output contract.
- [ ] Test bad JSON, giant bodies, refusals, truncation, wrong schema, ignored
      optional parameters, timeouts, 401/429/5xx and circuit recovery.
- [ ] Prompt-injection text cannot read secrets, change facts, choose arbitrary
      files/actions, alter the policy or trigger tool execution.
- [ ] Two concurrent reservations cannot overspend; uncertain costs do not release
      allowance incorrectly; unknown/free/paid routes remain distinct.
- [ ] Local-only never dispatches a cloud route, including through a localhost
      proxy or fallback; key material never reaches a different origin.

**Anti-pattern guards:** no assumption that every compatible API accepts `tools`,
`tool_choice`, `temperature`, a particular token-limit field, or conversation
continuation. No automatic paid/remote promotion, model-name-based "free" labels,
or use of the collector retry helper for secret-bearing requests.

## Phase 7: Portable Resume Tailoring And Supporting Documents

Depends on: Phases 2, 5 and 6.

**Read first:** R12 full referenced fragments; D8 conversion API; HANDOFF
Resume Tailoring section. Original scripts are research inputs, not runtime imports.

**What to implement**

1. Add `/Users/dyl/Workie/worker/documents/` with a locked Python environment,
   a JSON-in/result-out CLI, and synthetic fixtures. Node passes explicit argv
   and a minimal environment; models never choose commands/paths.
2. Create per-upload immutable template manifests: input hashes, format/version,
   editable anchors/clauses, frozen regions, line allocations, page geometry,
   font resources and links. Baseline selection follows actual job duties and
   configured role, not a hardcoded two-resume list.
3. Request structured edits to approved clauses/skills only, each tied to
   confirmed fact/evidence IDs. Preserve order/count of sections and bullets,
   employers, titles, dates, education, awards, project names/subtitles and links.
   Unsupported new facts, metrics, skills or claims fail validation.
4. **Fixed-PDF path:** extract the bounded glyph/line editing and independent
   checks from the E2/E3 source fragments. Replace template-specific counts,
   MCIDs, paths and historical hashes with validated manifest data. Reject
   unsupported operators/fonts/glyphs rather than deleting their guards.
   Isolate any unavoidable internal pypdf API behind a pinned contract test.
5. **Editable-source path:** support a qualified DOCX master plus its reference
   PDF and fonts. Patch only approved text anchors while preserving OOXML
   structure/styles/relationships, then render with a pinned LibreOffice
   process and unique user-profile directory. Qualify the unchanged source
   against the reference PDF first. This adapter is new work, not a capability
   supplied by the old scripts. Unqualified/unsupported sources require a
   compatible source/template through `needs_document`; never silently reflow.
6. Run document conversion in a constrained, network-disabled environment,
   with no ambient secrets, macros, external resource retrieval or shell escape,
   plus CPU/memory/time/output limits. Each attempt owns its scratch directory.
7. Validate raw/normalized text, exact changed regions, frozen glyph geometry,
   page count, line fit, links/annotation destinations and embedded fonts.
   Rasterize baseline/output with the same pinned renderer; compare pixels
   outside narrowly permitted regions. Overflow asks for another bounded
   wording proposal, not smaller fonts or moving frozen content.
8. Replace regex/octal URI extraction with parsed active annotations; distinguish
   preserved links from independently checked reachability. Preserve inherited
   punctuation diagnostics separately from introduced defects. Eliminate
   `/tmp/_cmp.xml`, ignored command failures and empty-output false passes.
9. Publish only a fully validated artifact. Store master/source/output hashes,
   edit map, evidence IDs, prompt/model versions, tool versions, checks and
   filenames. Regenerate unsent work after relevant master/fact edits; retain
   every submitted version unchanged.
10. Handle truly required cover letters/essays with the same facts and employer
    constraints. Prohibited AI-authored work becomes a manual-document intervention.
    Transcripts/certificates are supplied artifacts, never fabricated; redacted
    derivatives retain the protected original and their provenance.

**Verification checklist**

- [ ] Both a qualified fixed PDF and editable DOCX complete baseline-to-tailored
      PDF under the same manifest contract.
- [ ] Multiple synthetic template layouts prove no applicant-specific bullet/
      page/link counts are global assumptions.
- [ ] New unsupported facts, metric inflation, glyph loss, line overflow, changed
      frozen regions, font substitution and wrong master selection fail.
- [ ] Test escaped/octal/indirect URIs, broken render commands, zero extracted
      fonts/text, inherited punctuation, unsupported PDFs and concurrent attempts.
- [ ] Archive traversal, external resources and hostile source/PDF inputs remain contained.
- [ ] A failed candidate never becomes uploadable; manifest and bytes match.

**Anti-pattern guards:** no importing historical editor modules into production,
removing hash checks without a replacement invariant, treating a generated file
as QA proof, whole-resume rewrites, font shrinking, or unsupported-format success.

## Phase 8: Greenhouse/Ashby Unattended Vertical Slice

Depends on: Phases 1-7.

**Read first:** D7 official auth/locator/input/frame contracts; ATS authorization
matrix below; R8 source identity and network caveats; HANDOFF submission evidence.

**What to implement**

1. Add `/Users/dyl/Workie/worker/browser.ts` and concrete adapters under
   `/Users/dyl/Workie/worker/ats/`. The small shared contract discovers a form,
   applies approved answers/artifacts, verifies fields, submits through the
   guarded intent path, and reconciles receipt evidence.
2. Copy documented Playwright persistent-context, role/label locator, file upload,
   native select and frame patterns. Keep one browser controller. Persist logical
   step/field state, never DOM handles across navigation or a restart.
3. Protect navigation and subresources with approved origins and an egress layer
   that rejects private/link-local destinations and DNS rebinding at connection
   time. Include redirects, frames, popups, downloads and service workers in the
   threat model. A preflight hostname check alone is not this protection.
   Preserve the source/robots policy; an access refusal is a blocked reason,
   not permission to retry through a different client or undocumented endpoint.
4. Establish the official employer/tenant/requisition and full requirements.
   Public board data and partial descriptions are hints, not authority to answer
   legal/eligibility questions or proof that an API permits candidate submission.
   Implement deterministic screening in `/Users/dyl/Workie/worker/screening.ts`
   against confirmed education, term, location, authorization, availability and
   compensation facts. Record requirement excerpts and reasons. A model may
   propose a typed requirement, not decide that an unknown qualification is true.
   Ambiguous requirements become a scoped question/policy item; clear
   ineligibility becomes an evidenced skip, not a fabricated answer.
5. Implement Greenhouse and Ashby native/custom/conditional fields, repeatable
   sections, accessible autocomplete selections and uploads. Reconcile ATS
   parser outputs with confirmed facts and the intended attachment hash.
6. Handle unknown required fields through Phase 5. Optional questions follow
   policy. The constrained model fallback chooses only current observed,
   allowlisted action IDs; deterministic code supplies actual values and files.
7. Implement automatic `ready -> submitting -> submitted/unknown`, receipt
   capture and reconciliation. Submission success must bind applicant attempt,
   exact role/tenant and sent manifest, not a generic success phrase.
8. Add an intervention path that opens/focuses the correct dedicated browser
   on the paired host. Inspect real progress after the owner handles login or
   verification, then resume. No stealth, proxy rotation or CAPTCHA service.

**Verification checklist**

- [ ] Controlled Greenhouse and Ashby fixtures complete screening, tailored
      document upload, automated submission and an exact-role receipt.
- [ ] Greenhouse autocomplete requires a selected option; Ashby visible Yes
      without committed state is corrected after validation and not counted sent.
- [ ] Required unknown -> bell -> answer -> automatic resume works while another
      application finishes. Restart mid-flow preserves artifacts and facts.
- [ ] A committed submission with a dropped response reconciles to the original
      receipt without another external submit.
- [ ] A wrong-role/generic thank-you page, upload success, navigation or model
      `DONE` never satisfies receipt verification.
- [ ] Malicious site text/URLs cannot obtain secrets, cross-owner files, loopback
      services, unapproved documents or actions.

**Anti-pattern guards:** no generic click-all-fields bot, undocumented employer
API credentials, model-generated JavaScript, forced clicks through verification,
or claims that this first slice completes all ATS support.

## Phase 9: Lever And Jobvite

Depends on: Phase 8.

**Read first:** completed Phase 8 contract/tests; D7 input/locator documentation;
the Lever/Jobvite entries in the authorization matrix.

**What to implement**

1. Copy the qualified adapter structure, state guards and receipt contract into
   `/Users/dyl/Workie/worker/ats/lever.ts` and
   `/Users/dyl/Workie/worker/ats/jobvite.ts`. Only selectors/question mappings
   established by form inspection become adapter facts.
2. Cover tenant variations, custom/repeated fields, multi-step validation,
   uploads and permitted existing sessions. Treat source/contact-address fields
   as context-specific rather than changing the master applicant email.
3. Jobvite date entry uses correct ISO HTML input values while preserving the
   applicant's local date and precision. Verify displayed and committed values.
4. Reuse all blocking/recovery/receipt behavior; read-only feed availability
   does not enable employer-authenticated submission endpoints.

**Verification checklist**

- [ ] Both fixture families complete the full document-to-receipt flow.
- [ ] Custom fields, date/timezone boundaries, attachment replacement and
      field-level validation have named regression cases.
- [ ] Login/new-account policy, blocked verification, restart and unknown
      submission behave identically to the baseline contract.
- [ ] Unsupported tenant versions are visibly blocked and absent from supported counts.

**Anti-pattern guards:** no API-key scraping, fabricated dates, broad selector
fallback reported as tested support, or bypass of the submit-intent fence.

## Phase 10: Workday, Oracle Candidate Experience And iCIMS

Depends on: Phase 9.

**Read first:** qualified earlier adapters; D7 persistent sessions/frames/inputs;
the remaining ATS authorization entries; HANDOFF observed-case regression table.

**What to implement**

1. Add concrete adapters in `/Users/dyl/Workie/worker/ats/` for these three
   families; version their inspected flow fingerprints and checkpoint each step.
2. Workday: segmented month/year/calendar controls, repeated education/work
   entries, conditional pages, resume parsing and authenticated status evidence.
   Verify input after each focus change; never approximate a missing date component.
3. Oracle: reconcile parsed education completion/current flags and all employers
   against confirmed profile entries before submission. A dropdown option does
   not waive contradictory written eligibility requirements.
4. iCIMS: inspect the next step after an email entry before deciding whether an
   account is required. Default skip-new-account policy remains active.
   When account creation is explicitly enabled for that employer/domain,
   use unique generated credentials in the protected vault and record account
   creation separately from application receipt.
5. Cover frames, new tabs, conditional fields, upload replacement, terms
   fingerprints, expired sessions and resumable human challenges. Material
   arbitration/credit-check/contract terms outside policy become a typed decision.
6. No mailbox integration is needed for the baseline: the owner completes human
   verification in the paired browser and receipt can come from the success/status
   page. SMTP credentials never imply mailbox-reading permission.

**Verification checklist**

- [ ] All three synthetic families pass the entire flow and adapter contract.
- [ ] Tests reproduce Workday focus loss, Oracle false graduation/missing employer,
      and iCIMS email-then-create-password gates.
- [ ] Changing terms invalidate prior authorization; unchanged covered terms do
      not cause repetitive confirmation prompts.
- [ ] Verification expires/persists/fails without duplicate clicks or false success;
      completion of real intervention resumes the correct attempt.
- [ ] Existing-session reuse and explicitly allowed unique account creation are
      tested; guest-only/skip-new-account is never silently escalated.

**Anti-pattern guards:** no universal employer password, automatic new consent
outside policy, past-degree invention, CAPTCHA bypass, or using email delivery
as unqualified proof of application receipt.

## ATS Evidence Matrix

Maintain `/Users/dyl/Workie/docs/auto-apply-support.md` during implementation.
For each ATS and tenant/flow fingerprint record adapter version, supported
controls, known limits, document variants, fixture results, live-read date,
live-submit receipt reference and owner-authorized policy version.

At planning time all seven application adapters are **unimplemented and
unverified**. Existing collection connectors do not change that classification.
The required implementation groups are Greenhouse/Ashby, Lever/Jobvite, and
Workday/Oracle/iCIMS. Missing vendor documentation or a restricted live form
is a named discovery gap, not a made-up submission API.

### Documented Authorization Boundaries

These primary sources were read during Phase 0. The chosen baseline uses permitted
candidate-facing forms, not the employer/partner APIs listed for comparison.
Applicant enablement does not grant employer integration permissions.

| ATS | Verified Documentation / Consequence |
| --- | --- |
| Greenhouse | `https://docs.greenhouse.io/job-board.html`, Authentication, Retrieve a job, Submit an application: job-board GETs are public; submission requires an employer Job Board API key via Basic authentication. Use the job-post `id`, not `internal_job_id`. Its submission API can accept missing required fields, so completeness must be validated separately even on an authorized integration. |
| Ashby | `https://developers.ashbyhq.com/docs/public-job-posting-api`, `https://developers.ashbyhq.com/reference/authentication`, `https://developers.ashbyhq.com/reference/applicationformsubmit`, and `https://developers.ashbyhq.com/reference/applicationcreate`: public posting feed differs from API-key access; `applicationForm.submit` requires `candidatesWrite`. Form paths come from `jobPosting.info`. `application.create` is not a substitute. The guide/OpenAPI differ on multipart documentation; do not claim it tested. |
| Lever | `https://github.com/lever/postings-api`, Apply to a job posting and POST application rate limit: public GETs differ from POST, which requires an employer Super Admin-issued key. Required fields vary; files need the documented multipart path. An authorized response may include `applicationId`. Never copy its query-string credential into logs or browser code. |
| Jobvite | `https://help.jobvite.com/s/article/Career-Site-Integration-Options`, API Solution: custom API availability is contractual; the documented solution still uses a hosted or iframe apply page. No unrestricted candidate submission API was verified. |
| Workday | `https://developer.workday.com/documentation/GUID-4c354bdb-06cd-461d-a632-ea8303beaedb-enHYPHENus/SOAPAPIAuthenticationandSecurity`: enterprise API access involves registered clients/tenant authorization. No public applicant submission contract was verified; the existing collector is not authorization to replay internal form endpoints. |
| Oracle Candidate Experience | `https://docs.oracle.com/en/cloud/saas/human-resources/farws/api-recruiting-ce-job-requisitions.html` and `https://docs.oracle.com/en/cloud/saas/human-resources/farws/api-recruiting-job-applications.html` mark CE resources internal-only. `https://docs.oracle.com/en/cloud/saas/human-resources/farws/api-direct-apply-job-applications.html` describes a separate approved-partner surface. Do not use internal-only resources just because REST documentation is public. |
| iCIMS | `https://developer-community.icims.com/platform/services/standard-xml-feed-job-boards`, `https://developer-community.icims.com/faq`, and `https://developer-community.icims.com/applications/applicant-tracking/workflows-api`: feed/integration access requires OAuth/vendor onboarding or established credentials. A created person/job workflow association is not proof that candidate questions, documents and consents are complete. A full public applicant-side submission API was not verified. |

### Allowed Browser Call Shapes

From D7, to be used only with current observed values and authorized artifacts:

- `chromium.launchPersistentContext(userDataDir, options)` returns the persistent
  context. Do not share its directory between simultaneous processes.
- `page.getByRole(role, { name, exact: true })` and
  `page.getByLabel(label, { exact: true })` locate observed controls;
  multiple matches are an error to resolve, not a reason to click the first.
- `locator.fill(value)`, `locator.setChecked(value)` and
  `locator.selectOption({ value })` cover appropriate native controls.
  Autocomplete widgets require actual option selection, not just typed text.
- `locator.setInputFiles({ name, mimeType, buffer })` or a controlled file path
  selects an upload. If using a chooser, register
  `page.waitForEvent('filechooser')` before the triggering click.
- `page.frameLocator(observedSelector)` scopes iframe interactions. Never
  assume page-level labels select a field inside a frame.
- `context.storageState({ indexedDB: true })` can capture supported browser
  storage, not arbitrary session storage or completed application state.
  Persistent auth data stays protected and out of Git/build/log artifacts.

Receipt interpretation remains adapter-specific. A successful HTTP response,
upload, profile creation or navigation is not sufficient. Check role identity
and actual success/error/blocked details, then record the immutable sent manifest.

The final matrix must distinguish:

- Documented interface only.
- Fixture-tested controls and full synthetic receipt flow.
- Owner-authorized live form read for an exact tenant/version.
- Owner-policy-authorized real submission with exact-role receipt.
- Blocked/unsupported controls, permissions or verification requirements.

## Phase 11: Applications UI And Operational Integration

Depends on: Phases 1-10. Earlier phases expose the minimal UI needed to test their
flows; this phase completes the unified user-facing experience.

**Read first:** R9/R10 design and cache boundaries; R3 legacy storage;
R11 filter accessibility regressions; HANDOFF UI and acceptance requirements.

**What to implement**

1. Add `/Users/dyl/Workie/app/applications/page.tsx` and
   `/Users/dyl/Workie/app/settings/page.tsx`, with Profile/Applications/settings
   navigation and the private bell on each relevant header. Preserve the dense
   table/drawer, themes, public tabs, Manual Apply, outreach and Talkie.
2. Show company/role, baseline version, durable state/reason, last action,
   waiting question, runner health, provider/cost provenance and receipt.
   Paginate history; use existing compact controls and labeled icon buttons.
3. Make policy enablement, run start/pause/resume, safe retry, skip/cancel and
   emergency stop persist after reload. Distinguish active, blocked, unavailable,
   unknown submission and verified sent. No optimistic receipt/checkmark.
4. Signed-in applied status is owner-scoped. Preserve anonymous legacy marks and
   explicit import; a newly signed-in second user must not inherit the first
   user's private application state or drafts.
5. Finalize document/provider/runner configuration and actionable unavailable
   states. Expose resumable intervention on the actual worker host, and do not
   pretend a hosted page can directly call its localhost model/browser.
6. Add worker start/pair/status/stop/recovery commands and an opt-in service
   recipe. Do not install a service automatically or reuse the collector launchd
   label. Document backup, retention, artifact cleanup and credential revocation.

**Verification checklist**

- [ ] Test 375/390/414px phones, 768/1024px tablets and 1440px desktop in light/dark;
      title/company/Apply/outreach/bell/run controls remain visible and usable.
- [ ] Real keyboard checks cover native filter selection, focus return, Escape,
      all labels, busy/disabled controls and live status announcements.
- [ ] Two-user cache/principal-switch tests cover board, drawer, inbox, downloads
      and back/forward navigation; session refresh preserves same-user drafts.
- [ ] Existing paid/unknown filters, saved defaults, manual marks, source
      attribution, Talkie autosave and outreach partial/unknown-send recovery work.
- [ ] No dead control, silent poll failure, lost answer or withdrawal claim.

**Anti-pattern guards:** no landing page, oversized dashboard cards, nested
decorative cards, private data in shared SSR caches, or disabled tooltips made
unreachable with `pointer-events: none`.

## Phase 12: Verification, Documentation And Release Gate

Depends on: every required phase. Optional Jev work is not a release dependency.

**Read first:** R1 current release policy; R11 CI; all preceding phase checks;
HANDOFF acceptance items 1-10. Recheck current main/WIP before release actions.

**What to implement**

1. Add a controlled ATS fixture server and process-level integration suite under
   `/Users/dyl/Workie/tests/auto-apply/`. Generate synthetic applicants/resumes;
   deny outbound employer/provider network by default. Explicit fixture-host
   exceptions must be impossible to enable by an ordinary production request.
2. Add separate browser, worker and PDF checks to the existing verification
   workflow. Browser/PDF jobs get explicit prerequisites and timeouts without
   changing the collector workflow's ownership or exposing its secrets.
3. Run crash/revocation/overlap fault injection across scan staging, answer save,
   budget reservation, upload, intent commit, external submit, receipt capture
   and final acknowledgement. Verify invariants, not just UI happy paths.
4. Document secure configuration, auth bootstrap, private migrations,
   worker install/pair/unpair/start/recovery, model verification, source/format
   support, emergency-stop limitations and support proof levels.
5. Prepare backward-compatible migrations, private backups and a tested rollback
   that disables new execution without erasing questions/receipts. Keep the
   feature disabled in production until configuration, tests and owner policy
   are ready. A deployment does not enable submissions.
6. During an authorized implementation session, provide a running local app URL
   and worker status against scratch data. If production release is authorized,
   follow the repository's direct-main/personal-author workflow; do not invent
   a staging branch or import Hemut's PR policy.
7. A real pilot is separate: use the authenticated owner's real profile,
   supported job and enabled policy. Do not submit fake applicants to employers.
   Record live receipt evidence separately; absence of a pilot remains explicit.

**Verification checklist**

- [ ] Every required phase's checks have an execution record tied to the tested revision.
- [ ] All ten handoff acceptance items below have evidence, not just a linked implementation.
- [ ] Re-read the selected dependency documentation and verify call signatures
      against installed versions; no unsupported parameters or presumed APIs remain.
- [ ] Required tests, typecheck, lint, build, document/worker/browser checks and
      anti-pattern review pass, or exact baseline failures are explicitly reported.
- [ ] All seven ATS families have passing controlled flows; live-read/live-submit
      claims are limited to the specific evidence actually collected.
- [ ] Local/private HTTP deployment, backup/restore, stop/revocation and rollback
      are tested without access to the production corpus or fake employer submissions.
- [ ] Configuration/start/recovery docs, support matrices and residual blockers are current.
- [ ] Release and production enablement have their own authorization and verification.

**Required commands**

Run the existing commands from `/Users/dyl/Workie`:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
git diff --check
```

Add these scripts as part of implementation, then execute them:

```bash
npm run test:worker
npm run test:documents
npm run test:e2e
```

They do not exist yet. Do not report them as passing before adding/running them.
Separate dev/build output directories or stop the development build process
before production build verification; do not clobber an active `.next` server.
Sanitize test environments so no production database, mailbox or provider
credential can be selected by a default.

**Anti-pattern scan**

Check new application/worker code for forbidden source imports, direct corpus
writes, global owner IDs, public object URLs, logging of secrets/profile values,
model-generated execution, hidden retry-on-submit, plaintext browser-state
artifacts, and dependencies on Codex/session tooling. Examples to inspect, not
automatically delete:

```bash
rg -n 'send_message_to_thread|cua_repl|fixed_editor_v[23]|/tmp/_cmp.xml' worker lib/applications app/applications
rg -n 'pushRemote|pullRemote|WORKIE_ALLOW_LOCAL_REFRESH|respectRobots: false' worker lib/applications
rg -n 'eval\(|new Function|shell: true|console\.log|localStorage|s-maxage' worker lib/applications app/profile app/applications app/settings
```

Review matches with context: a denial test/string is not itself prohibited behavior.
Add a synthetic-secret bundle/log scan without printing real secrets.

### Acceptance Traceability

| Handoff Acceptance | Implemented In | Required Proof |
| --- | --- | --- |
| 1. Two-user privacy | 1, 2, 3, 5, 11 | Browser/API/worker/file isolation, forged ownership and revoked credential tests, including hosted-style HTTP. |
| 2. Providers/privacy/cost | 6 | Local/compatible/BYOK contracts, malformed output/injection, reservations, unknown price and fallback denial. |
| 3. More than 200 jobs | 4 | 601-job snapshot, overlapping runs, stale corpus changes, restart and no silent truncation. |
| 4. Exact-format document through receipt | 7, 8-10 | Both qualified source paths, artifact hashes/QA, actual fixture uploads and exact-role receipt. |
| 5. Bell answer and resume | 5, 8 | Reload-safe answer, atomic/idempotent matching wake-up, unrelated work progressing. |
| 6. Truthful details/documents | 2, 7-10 | All observed education/authorization/pay/contact/conditional-field fixtures. |
| 7. Human/unsupported/uncertain recovery | 3, 5, 8-10 | Actionable interventions, crash near Submit and no blind resubmission. |
| 8. Seven ATS families | 8-10 | Each family's complete fixture flow and precise, separately labeled live evidence. |
| 9. Corpus and existing features preserved | 1, 4, 11 | Scratch mirror/cache isolation plus board/filter/Talkie/outreach regressions. |
| 10. Usable responsive UI | 5, 11 | Real screenshots/geometry, keyboard/focus, reload and offline/error-state checks. |

### Completion Evidence

Do not call the implementation complete with only scaffolding, link opening,
resume generation or the first two adapters. The release record must contain:

- Exact source revision and commands/results, including pre-existing failures.
- Seven-family fixture support matrix and qualified document-format matrix.
- Full autonomous synthetic run and answer/intervention/restart recovery evidence.
- Two-user security and private-data/corpus-cache isolation evidence.
- Cost/locality/credential tests; actual configured provider probes labeled separately.
- Local app/worker start instructions and operating health.
- Authorized deployment SHA/status, or an explicit not-deployed statement.
- Live receipt references if a pilot was authorized; otherwise no live-submit claim.

## Optional Jev Experiment

Only after the baseline passes Phase 12 and profiling shows decision inference is
a material bottleneck. Read D9 again; current terms/cost/account access must be
checked at that time. Do not integrate the complete Python agent as a second
browser controller or make it a prerequisite for free/local operation.

A small hosted decision adapter may choose among redacted, current observed
action IDs. Workie still controls values, artifacts, policy, browser execution
and receipt verification. Disable it in local-only mode; require explicit remote
provider/budget approval. Never send credentials, OTPs, EEO answers or filled
identity values just to choose a field.

Compare identical synthetic ATS tasks/policies: verified completions, wrong-field
writes, duplicate submits, recovery, p50/p95 decision and whole-application latency,
and total provider cost. Adopt only if correctness is preserved and measured
benefit justifies it. Its published flight-search result is not ATS performance proof.

## Configuration And Remaining Gates

Proposed secure example settings, all new unless already documented:

| Setting | Purpose |
| --- | --- |
| `WORKIE_PRIVATE_DATABASE_URL` / `WORKIE_PRIVATE_DATABASE_AUTH_TOKEN` | Explicit private store; never alias the corpus connection. |
| `BETTER_AUTH_SECRET` / `BETTER_AUTH_URL` | Private auth deployment; separate trusted local/preview/production origins. |
| `WORKIE_APPLICANT_EMAIL_ALLOWLIST` / `WORKIE_AUTH_MAIL_FROM` | Personal-app enrollment scope and explicitly selected transactional sender. |
| `BLOB_READ_WRITE_TOKEN` plus the configured private store | Server-held private upload credential; never provided to a worker/browser as a store-wide key. |
| `WORKIE_CREDENTIAL_ENCRYPTION_KEY` | Server-side envelope key when hosted credential storage is enabled; version and rotate. |
| Worker control-plane origin/data directory | Non-secret configuration, outside the repo/public directory. Tokens/provider keys go to protected storage. |

Implementation can proceed against synthetic fixtures without real LLM keys or
employer logins. Production availability additionally requires:

1. Authorized provisioning/configuration of a private database, private object
   storage and authenticated mail delivery. Review actual cost/quotas first;
   no new subscription or resource was created during planning.
2. A paired, trusted, awake worker with qualified browser/PDF toolchain.
3. Owner-confirmed profile, compatible masters/fonts and accepted policy.
4. An actually available local model or owner-configured provider with verified
   locality/capabilities and permitted cost. No free route is assumed.
5. Tenant-specific form qualification and any legitimate owner-handled login,
   verification or terms decisions. No universal ATS success promise.

Leave existing `.env.local`, personal OmniRoute, GitHub refresh configuration,
cron-job.org job and production credentials alone. Do not use `vercel link` or
`vercel env pull` as a setup shortcut that overwrites local configuration.

## Session Handoff Template

At the end of each implementation phase, append its small execution record to
`/Users/dyl/Workie/docs/auto-apply-progress.md`:

```text
Phase and status:
Starting / ending revision:
Files changed:
Documentation sections actually read:
Commands and exact results:
Fixture / live-read / live-submit evidence:
Schema, protocol and support-matrix versions:
Open blockers and next phase:
Explicitly not performed:
```

Do not include secrets or personal answers. Re-read this plan's relevant source
references in the next context; do not assume a prior worker's conclusion proves
an API, migration, model capability or employer receipt.
