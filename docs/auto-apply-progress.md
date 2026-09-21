# Auto Apply Progress

## TypeSafe Authorization

September 21, 2026: the user requested Jev integration, installed the TypeSafe
skill, reported having an API key, and approved a $10 budget. Interpret this as
USD 10 total for Workie's TypeSafe integration/testing, including retries, not a
recurring daily allowance or approval for other paid providers. This supersedes
the earlier optional-Jev exclusion for implementation scope.

The user saved the key in the local login Keychain on September 21, 2026.
An exact metadata-only lookup succeeded for service `Workie TypeSafe API`,
account `dongyeop0810@gmail.com`, in `~/Library/Keychains/login.keychain-db`.
No password retrieval flags were used; no key value was read or displayed.
The item exists, but its contents and TypeSafe authentication are not yet tested.
The default macOS provider read now uses the shell-free `/usr/bin/security`
command with a five-second timeout; the first non-interactive read returned
`PROVIDER_CREDENTIAL_UNAVAILABLE` without making a provider request, so no
TypeSafe budget was spent. A foreground macOS Keychain authorization is still
needed before live authentication can be verified.
The Phase 6 provider helper and local worker path now use this exact
service/account. The worker invokes Jev only when the owner-scoped policy
explicitly enables `typesafe_jev`, refreshes that policy before each decision,
and fails closed when the provider is disabled or unavailable. The cumulative
$10 spending guard is implemented and synthetic-tested; no TypeSafe paid calls
have been made by this task.
On September 21, 2026, the
user explicitly approved sending redacted form labels and action choices to
TypeSafe for their own account, excluding passwords, OTPs and sensitive answers.
This is not permission to send full profiles, resumes, filled identity values
or arbitrary page content. Bind the approval to the authenticated applicant
before use; it does not authorize disclosure for the second applicant.
Synthetic tests need no personal data.

Use the installed `/Users/dyl/.agents/skills/typesafe-ai/SKILL.md` and current
official API documentation. Add secure provider-key entry through the worker's
keychain path; the existing hidden pairing-grant prompt is not an API-key prompt.
Do not request the key in chat or place it in command arguments, URLs or logs.

## Phase 6 Acceptance

September 21, 2026: the scoped Jev provider and local-worker runtime
integration is ACCEPTED on
`DY/workie-auto-apply`. `worker/providers.ts` validates the TypeSafe request and
versioned response contract, redacts state before dispatch, binds the approved
owner and endpoint, reads the exact local keychain item without displaying its
value, bounds response bodies, and accounts conservatively for reserved and
reported input usage. The separate file-backed ledger prevents concurrent
reservations from exceeding the approved cumulative USD 10 allowance.
`worker/main.ts` obtains owner-scoped provider policy after the worker lock and
passes a cancellable, policy-refreshing selector into safe-stage dispatch; Jev
can select only the current observed actions.

| Accepted evidence | Result / reference |
| --- | --- |
| Provider checks | 9/9 PASS; `worker/providers.check.mjs` |
| Full worker gate | 57/57 PASS on pinned Node 22.23.2 |
| Source checks | TypeScript, focused ESLint and `git diff --check` PASS |
| Network scope | Synthetic mock only; no TypeSafe request, production database write, ATS submission, SMTP send or deployment |

This acceptance covers the Jev decision-provider slice and its local worker
invocation. Provider settings UI, OmniRoute/local/BYOK adapters, live
credential authentication, and later document/application phases remain
outstanding.

## Phase 7 Acceptance

September 21, 2026: the portable document runtime is implemented on
`DY/workie-auto-apply`. Each source gets a versioned hash/anchor/frozen-text
manifest; edits require confirmed evidence IDs and the original master hash.
DOCX edits preserve the OOXML package and, when a reference PDF is supplied,
qualify the source before editing and compare the rendered output's page,
geometry, font and link signatures. Fixed-PDF editing is intentionally limited
to printable-ASCII literals with unchanged byte width, extracted text and font
resources; unsupported PDFs fail closed. Active PDF links are read from parsed
Link annotations, not raw URI text matches. Python subprocesses receive no
ambient secrets and every attempt owns a private scratch directory.

| Accepted evidence | Result / reference |
| --- | --- |
| Document checks | 5/5 substantive PASS; `npm run test:documents` |
| Hostile/parallel behavior | Evidence binding, overflow/stale-master rejection and concurrent scratch isolation PASS |
| Source checks | TypeScript, focused ESLint, Python compile and `git diff --check` PASS |
| Environment boundary | Positive DOCX reference-render test skipped because this host's `soffice` wrapper has no LibreOffice binary; production fails closed when the renderer is unavailable |

No real applicant documents, provider requests, ATS submissions, production
writes or deployments were performed. Phase 8 is now in progress; this
acceptance is not a claim that Auto Apply is release-ready.

## Phase 8 Progress

September 21, 2026: the first controlled ATS slice is implemented in the local
worker. `worker/browser.ts` owns a persistent Playwright context, blocks service
workers, checks every approved-origin request and redirect, and rejects private
DNS answers before continuing a request. `worker/ats/protocol.ts` is the shared
field/receipt contract; the Greenhouse and Ashby adapters use explicit accessible
labels, committed select/radio values, file upload reconciliation and exact
receipt identity checks. `worker/screening.ts` makes country, degree, major,
term, authorization and pay decisions deterministically. `worker/application-runner.ts`
keeps submission deterministic while an optional Jev selector can rank only the
currently observed non-submit actions. Discovery snapshots retain the
authoritative posting row and an official-content hash; the authenticated worker
context re-reads that row, rechecks ATS identity, and parses its exact description
with deterministic rules before screening.

| Accepted evidence | Result / reference |
| --- | --- |
| Controlled ATS fixtures | 2/2 PASS; `npm run test:ats` |
| Safety cases | Egress block, wrong-role rejection and ineligible skip PASS |
| Boundary | Local synthetic pages only; a master resume is deliberately rejected until a persisted tailored artifact and verification manifest exist; live ATS submissions remain outstanding |

This is not live Greenhouse/Ashby support or release authorization. The browser
runtime fails closed when its browser binary or approved origin is unavailable,
and the current worker cannot advance from tailoring with a master resume alone.

## Current Phase 5 Execution

Objective: finish the entire approved Auto Apply plan, not only discovery.
Phase 4 is accepted, committed and pushed as
`669483c3b3bec3b5b696023e2c59ae30844e5ac8`. Phase 5, the scoped Phase 6
provider/runtime integration, and Phase 7 are now ACCEPTED; Phases 8-12 remain
not started.

| Current owner | Native agent | Scope |
| --- | --- | --- |
| Question DAL (Astra) | `01a0c356-a0b3-7a31-9b7b-c686a1517ff2` | Missing store and transaction tests; authoritative answer-update availability |
| HTTP/runtime integration (Astra) | `01a0c364-1654-78c0-b73a-ca37575869b0` | Private routes, worker question transport and durable intervention polling |

The bounded UI assignment completed and closed: 11 unit tests, scoped types/lint
passed, and the final rendered gate passed all 132 browser cases across
mobile390/desktop1440 and light/dark themes. The gate used the existing synthetic
question fixture and a seeded isolated `workie.db`; it did not touch production
data. Receipt: `logs/auto-apply-gate/phase5-inbox-ui-final-node22/results.json`.

September 21 resume: previous Phase 5 workers were confirmed interrupted and
unavailable; no active test processes remained. Protocol/schema/migration and
most client UI survived, but `questions.ts`, API routes and worker integration
were still absent. Complete the DAL first, then add HTTP/intervention integration.
The narrower UI role consumes server `canAnswer`, never infers authorization.
Saved-answer updates must affect eligible unsent work without changing submitted
history; merely retaining an unsendable newer draft is not completion.

Phase 5 integration is complete: the question DAL, private routes, worker
question/intervention transport, encrypted draft recovery and notification bell
are covered by focused tests and the rendered gate. Contract revision 2 carries
current profile/policy revisions, scope hash and fact versions on `ReviewCommand`;
resolved document updates load only owned available document choices.

### Phase 5 Acceptance

| Accepted evidence | Result / reference |
| --- | --- |
| Rendered browser gate | 132/132 PASS; four viewport/theme projects; `logs/auto-apply-gate/phase5-inbox-ui-final3/results.json` |
| Production build | `npm run build` PASS on Node 22; two pre-existing `lib/auto-apply.test.ts` unused-variable warnings remain |
| Source checks | Focused Vitest/HTTP/runtime/worker checks, TypeScript, ESLint and whitespace checks PASS |
| Scope | Synthetic/local only; no TypeSafe call, ATS submission, SMTP, production database write, deployment or credential use |

The browser gate initially exposed stale-bundle and fixture-timing defects; the
final run was repeated from a fresh production build after the wait assertions
and isolated database setup were corrected. Phase 5 is accepted; this does not
claim the full Auto Apply plan is complete.

Two workers maximum. Shared working contract currently lives at
`phase5-contract.json` (coordination artifact, exclude from the eventual source
commit or move under ignored gate logs). UI questions: `phase5-ui-contract-queries.json`.
Backend owns schemas/migrations; UI owns icon dependency and header edits. Both
must finish focused checks and freeze before the independent final build/browser
gate. Never use `send_message_to_thread` or wrappers. No production enablement,
real applicant data, credentials, ATS submissions, model calls or scheduler changes.
Only verified working-branch commits/pushes are authorized.

Accepted Phase 4 evidence: `phase4-final-ZugXqk`, source
`007d1305974aaada9e77624fc6d9dfa8db6a736183cfda30bcf393dc4eefc6fd`;
1,593 unit tests, 32 worker checks, 32 discovery + 56 worker + 128 profile browser
cases. All passed with types/lint/build and process cleanup; the two baseline
lint warnings remain. Parent verified the current 347-file source hash inventory
and raw browser counts. No live submission or production deployment is claimed.

## Current Phase 4 Acceptance

September 21, 2026: Phase 4 is parent-ACCEPTED after final verification and
review closure. Phase 5 is READY, NOT STARTED; the full plan's Phases 5-12
remain outstanding. This role is COMMIT ONLY from
`53e96e34baf0fe78b048dbf72122232a0a1e90dd` on `DY/workie-auto-apply`.

| Accepted evidence | Result / reference |
| --- | --- |
| Final gate | `logs/auto-apply-gate/phase4-final-gate.json` and `phase4-rendered-ready.json`; raw evidence in `logs/auto-apply-gate/phase4-final-ZugXqk/` |
| Checks | 1,593 unit tests, 32 worker-runtime checks, build, types, lint and whitespace PASS |
| Rendered regression | 32 discovery, 56 worker and 128 profile identities PASS; no errors, skips, retries or flakes; 156 screenshots reviewed |
| Review closure | `logs/auto-apply-gate/phase4-review-fixes-ready.json`: both backend findings fixed; parent confirmed three-file and selector closure, no open findings |
| Accepted build | `9qm9ixm50fULEEAPJN9ik` |
| Accepted source | `007d1305974aaada9e77624fc6d9dfa8db6a736183cfda30bcf393dc4eefc6fd`; all 347 current hashes match `phase4-final-ZugXqk/source-after.json` before the two ledger edits |

Earlier pending-acceptance fields and failed/interrupted runs remain historical;
this explicit parent decision supersedes them. Evidence is local/synthetic only,
not live ATS/provider/document-tailoring proof. Production is not enabled.
No app-code edits, tests or builds are run by this commit role; retained evidence
is not a new docs-inclusive run. Only these two ledgers change after the freeze.
Keep `HANDOFF.md` untracked and exclude logs, environment files and databases.
Receipt: ignored `logs/auto-apply-gate/phase4-commit.json`. No push, deploy,
main changes, nested agents or cross-task messaging. Phase 5 needs a separate
implementation assignment; Auto Apply is not complete.

## Historical Phase 4 Execution

The execution records below are preserved history, superseded by acceptance above.

Current continuation: final reviewer and verifier were interrupted. The actual
Next/Playwright children survived; their existing run is being adopted rather
than duplicated. `phase4-final-R1eGaB` records 1,590 unit tests, 32 worker checks,
types/lint and build `H9H_PKDMZOYQY-WsqneNc` passing, followed by discovery UI
failures. This is not an accepted gate.

| Current owner | Native agent | Remaining work |
| --- | --- | --- |
| Browser/UI gate | `01a0c315-4c43-7073-a898-8af1d27458f9` | Adopt test processes, diagnose rendered failures, verify fresh final build |
| Backend review/fixes | `01a0c315-4f81-7090-8900-ff76c23d3aa1` | Finish Phase 4 review; test corpus replacement and fix confirmed defects |

At most two workers; no messaging through `send_message_to_thread` or its
variants, no real credentials/data, no production writes/deployments. Goal remains
the full approved plan. Phases 5-12 are not started.

Resumed September 21, 2026 after authoritative task inspection confirmed all three
previous Phase 4 turns interrupted and no remaining Workie test process. Existing
WIP is retained. Current execution uses at most two workers under the updated
cost-conscious instructions; no model/provider or safety boundary changed.

| Resumed lane | Native agent | Scope / next gate |
| --- | --- | --- |
| Source | `01a0c2dc-5527-7eb0-8a74-eda4543e4aee` | Missing snapshot/identity modules and focused checks |
| Backend | `01a0c2dc-5787-7fa1-8885-8711c8360063` | Complete existing staging/import/attempt WIP and integration checks |

Source lane completed 158 focused tests and lint. Its worker is closed; the UI
lane is now `01a0c2fd-9b8e-7890-8c0a-6ff3814a012c`, leaving at most two workers.
Parent resolved the remaining Jobvite path documentation gap on September 21:
`jobs.jobvite.com/robots.txt` returned 404; a single public read of
`https://jobs.jobvite.com/ookla/job/objCAfwq` returned the title
`Ookla Careers - Software Engineer II` and the same canonical URL. This verifies
the hosted URL shape only, not native API permissions or submission support.

UI work follows the finalized contract. No source is currently accepted for
Phase 4; the next required proof is all 601 requisitions captured once with
restartable staging and owner-scoped import.

Remote verification readback: GitHub run `35570311397`, workflow `verify`,
commit `53e96e34baf0fe78b048dbf72122232a0a1e90dd`, created
`2026-09-21T06:52:06Z`, completed successfully. This confirms the existing CI
checks for Phase 3, not the uncommitted Phase 4 work or live submissions.

Phase 3 was accepted, committed and pushed as
`53e96e34baf0fe78b048dbf72122232a0a1e90dd`. Phase 4 is now IN PROGRESS,
not accepted. The active goal remains the complete approved plan.

| Lane | Native agent | Exclusive scope |
| --- | --- | --- |
| Corpus snapshot and identity | `01a0c2be-01de-7392-9c1c-fc7424aafdb6` | Read-only corpus snapshot, explicit filters, official identity parser |
| Private discovery backend | `01a0c2be-031d-72b1-90a6-4bde42ceef4a` | Immutable staging, target/attempt history, cap backlog, legacy import, private migration |

The source lane publishes `phase4-source-contract.json`; backend publishes
`phase4-backend-contract.json` under ignored gate logs before UI integration.
No production, corpus writes, submissions, credential use or service installation.

## Historical Phase 3 Acceptance

September 20, 2026 (Pacific): Phase 3 is parent-ACCEPTED by explicit authorization
after final verification and review closure. Phase 4 is READY, NOT STARTED.
This is Phase 3 COMMIT ONLY from `3ed686118c70fdc5f4fe4b7cab2598f7d5d6c4e7`
on `DY/workie-auto-apply`; no push, main changes, merge, rebase or deployment.

| Accepted proof | Result / reference |
| --- | --- |
| Final gate | `logs/auto-apply-gate/phase3-rendered-ready.json`; raw evidence in `logs/auto-apply-gate/phase3-final-NdxNJU/` |
| Checks | 1,487 unit/integration tests and 32 worker checks PASS; build, types, lint and whitespace PASS; two unchanged lint warnings |
| Rendered regression | 56 worker and 128 profile identities PASS; no failures, skips, retries or flakes |
| Review closure | Parent-confirmed Noether security closure after two queue fixes; Cicero UI/quality closure; parent reviewed final selector-only diff with all 14 titles/assertions unchanged |
| Accepted build | `Kj7UpmcEl8DIGH6KHrsOK` |
| Accepted source | `4d9f3a0f210d32ee2158334653d6f3e317e661baeb4e1ed13dc5d27da9912247`; 317 hashes in `phase3-final-NdxNJU/source-before.json` |

The report's earlier `phaseAccepted: false` and pending parent-review text remain
historical; acceptance is this subsequent explicit parent decision. The commit
role verified all 317 hashes before editing only these two ledger docs; retained
checks are not a new docs-inclusive run. No tests or builds are rerun here.
Proof is synthetic/local, not live ATS, provider or document-tailoring evidence.
Phase 3 acceptance does not complete Auto Apply.

Next: read `plans/auto-apply.md` Phase 4 and
`logs/auto-apply-gate/phase4-parent-handoff.md`. Implementation and working-branch
sync require separate authorization. Keep `HANDOFF.md` untracked, and logs,
actual environment files and databases out of the commit. The ignored receipt
is `logs/auto-apply-gate/phase3-commit.json`. No nested agents or
`send_message_to_thread` in any namespace/wrapper.

## Historical Phase 3 Execution

The interrupted execution and earlier Phase 2 handoff below are preserved history,
superseded by the current acceptance record above.

Execution has resumed under the active goal to finish the full approved plan.
Phase 3 is IN PROGRESS, not accepted. Fresh owners continue the existing WIP;
no prior Workie test/server process remains.

| Resumed lane | Native agent | Gate |
| --- | --- | --- |
| Server | `01a0c26b-0b2e-7301-9244-4006be6f2c04` | Finish retry/revocation checks and server contract |
| Runtime | `01a0c26b-18c6-72a1-94aa-6dcaf4965cc7` | Worker/CLI recovery and process-level checks |
| UI | `01a0c26b-1a71-7ef0-a51c-14fb06200057` | Source/controller checks, then integration browser gate |

The prior execution was interrupted before verification or acceptance. All three
listed agent IDs are no longer available to the native agent manager. The process
check found no remaining Workie test/server process; unrelated servers were left
untouched. Phase 3 WIP is preserved and uncommitted. On continuation, read the
`phase3-*-contract-feedback.json` files, finish each lane, then run independent
integration, security, quality and rendered-UI checks before committing.

Phase 2 was accepted, committed and pushed as
`3ed686118c70fdc5f4fe4b7cab2598f7d5d6c4e7` on `DY/workie-auto-apply`.
Phase 3 is now IN PROGRESS, not accepted. Main and production remain unchanged.
The historical Phase 2 handoff below is superseded by this current record.

| Lane | Native agent | Exclusive scope |
| --- | --- | --- |
| Server | `01a0c253-c763-7fe0-82de-166638a55347` | Shared worker protocol/state, private worker schema/migration, pairing/run/worker routes and tests |
| Runtime | `01a0c254-3016-7493-b084-58b973daa953` | `worker/`, keychain dependency and package scripts, worker operating docs |

Server publishes `logs/auto-apply-gate/phase3-protocol-contract.json` before
runtime/UI integration. No competing schema/package owners. Tests use synthetic
private data and loopback services only; no real keychain enumeration, application
submissions, production migrations, service installation or deployment.

Execution began: September 20, 2026.
Current gate: Phase 2 ACCEPTED by explicit parent authorization after independent
final verification and review closure PASS. Phase 3 READY, NOT STARTED.
This role is Phase 2 COMMIT ONLY from `d4e3a9c`; no push.
Phase 0 was committed/pushed as `88cea14`;
Phase 1 was committed/pushed as `d4e3a9c` on `DY/workie-auto-apply`.
Further implementation or branch sync requires a separate parent assignment.
Main changes, deployment, production enablement, live pilots and employer
submissions are not authorized. Historical pending/failure statements below
remain evidence of earlier attempts, not current status.

## Baseline And Source Integrity

- Write root: `/Users/dyl/.codex/worktrees/workie-auto-apply/Workie`.
- Original read-only source root: `/Users/dyl/Workie`.
- Initial state: clean detached HEAD at
  `a68c3fadeca161c6d44ca337ba073ffea50a9e13`.
- Observed local refs `main`, `origin/main`, `origin/HEAD` resolve to that HEAD.
  No fetch was performed; remote-tracking refs are not a fresh server read.
- Created `DY/workie-auto-apply` after confirming it did not exist. Starting
  HEAD remains unchanged; original `main` checkout remains separate.
- Runtime: Node `v22.23.2`; CI selects Node 22. Lockfile version 3.
- No repo ECC2 state/config found. Use this ledger plus
  `auto-apply-workflow.md`, not a new state-store framework.

| Preserved input | SHA-256 |
| --- | --- |
| `plans/auto-apply.md` | `bad000caef7c019d94f46136aa17128d21eade93ba13670501f43e4656224e00` |
| `HANDOFF.md` | `ff93af1bdd081df59294f7fc61d18ea4aaf321ac3710275d8418ccce6f877efa` |
| `package.json` | `63c7d78d571fa76453cb458d22823b045b19331615606e544b12b2bdb8cfcca7` |
| `package-lock.json` | `7b7c3a91b46162fada0832eb713bbecce32a6dac6ea3ea9ed268ea9d4a07e296` |

The plan's historical Phase 0 is documentation discovery. The current Phase 0
assignment adds isolated setup and a command/handoff harness; it does not
reclassify discovery as a tested implementation. Original plan/handoff text and
absolute links stay intact. All proposed writes translate to the write root.

## Phase Matrix

All write surfaces below are relative to the worktree, never the original root.
Roles are assignments/contracts, not evidence that another agent was spawned.

| Phase | Dependencies | Implementation role / write surface | Required gate | Status |
| --- | --- | --- | --- | --- |
| 0: Discovery/setup | None | Branch/Setup: copied inputs, two workflow docs, `scripts/auto-apply-gate.mjs` | Source equality, exact install, baseline, harness self-check, independent review | ACCEPTED; qualified build passed; offline font-fetch limitation retained |
| 1: Private storage/auth | 0 | Auth/storage: `lib/private-db/`, `drizzle-private/`, private Drizzle config, auth/access modules/routes | Two-user isolation, real async scratch transactions/migrations, auth/revocation/mail sink, corpus-cache separation | ACCEPTED; committed/pushed as d4e3a9c |
| 2: Profile/policy/documents | 1 | Profile/documents: `app/profile/`, profile schemas, document/policy routes and private schema | All sections, revision/draft isolation, hostile upload checks, immutable masters, disabled policy default | ACCEPTED; committed/pushed as 3ed6861 |
| 3: Pairing/worker | 1-2 | Worker: `worker/main.ts`, state/lease/pairing modules and worker routes | Grants/fences/revocation, process restart/sleep, safe checkpoints, independent waiting work | ACCEPTED; committed/pushed as 53e96e3 |
| 4: Discovery/identity | 1-3 | Discovery: application discovery/run targets, approved shared query extraction, legacy-import flow | 601 jobs, overlap/restart, immutable identities, backlog/caps, confirmed manual suppression | parent-ACCEPTED; final verification/review closure; commit authorized, no push |
| 5: Questions/bell | 1-4 | Inbox: questions/waiters, inbox/answer routes, `app/notification-bell.tsx`, approved headers | Atomic/idempotent scoped resume, reload/offline drafts, no shared-cache leaks, accessible bell | ACCEPTED; 132 rendered cases and focused checks passed |
| 6: Providers/cost | 1-5 | Provider: `worker/providers.ts`, settings/credential/budget modules | Mock protocols, untrusted output, reservation races, unknown cost and remote-fallback denial | NOT STARTED |
| 7: Documents | 2, 5, 6 | Document runtime: `worker/documents/`, synthetic source/PDF fixtures and checks | Qualified PDF/DOCX, unchanged geometry/fonts/links, hostile inputs, parallel scratch isolation | ACCEPTED; pending commit |
| 8: Greenhouse/Ashby | 1-7 | Browser/ATS: `worker/browser.ts`, `worker/screening.ts`, first adapters/fixtures | Full synthetic receipt flow, answer/intervention/restart, unknown-submit reconciliation, egress | IN PROGRESS; local fixture slice |
| 9: Lever/Jobvite | 8 | ATS: two adapter/fixture families, support evidence | Date/control/upload regressions, exact-role receipts, unsupported-version blocks | NOT STARTED |
| 10: Workday/Oracle/iCIMS | 9 | ATS: three adapter/fixture families, support evidence | Segmented dates, parsed-fact reconciliation, account/terms/intervention rules | NOT STARTED |
| 11: Applications/operations | 1-10 | UI/integration: applications/settings/navigation, worker commands and operating docs | Responsive light/dark/keyboard, principal-switch/cache, persisted controls, legacy regressions | NOT STARTED |
| 12: Release gate | 0-11 | Verification/docs: `tests/auto-apply/`, verify CI, support/config/recovery/rollback docs | All ten acceptance items; full worker/document/browser tests; independent release authorization | NOT STARTED |

Jev remains an optional typed provider in Phase 6 and is not a release
dependency. Seven ATS application families and both document paths remain
UNIMPLEMENTED/UNVERIFIED.
Package/lockfile, private schema, shared UI headers and CI have one integration
owner at a time. The parent operator assigns independent verification,
anti-pattern and code-quality reviewers after each implementation handoff.

## Phase 0 Execution Record

Historical implementation record below; acceptance and commit authorization
are recorded in the final Parent Acceptance section.

- Status: implementation handed off for independent review; do not treat
  Phase 0 as accepted or begin Phase 1 from command results alone.
- Starting/ending revision: `a68c3fadeca161c6d44ca337ba073ffea50a9e13`;
  uncommitted setup artifacts only.
- Changed files: byte-identical additions `plans/auto-apply.md`, `HANDOFF.md`;
  new `docs/auto-apply-progress.md`, `docs/auto-apply-workflow.md`,
  `scripts/auto-apply-gate.mjs`. No tracked application code, package scripts,
  lockfile, migrations or CI files changed.
- Sources actually read: full approved plan and handoff; `README.md`;
  `package.json`/lockfile; TypeScript, ESLint, Next and Vitest configs;
  `.gitignore`; `.github/workflows/verify.yml`; `lib/db/index.ts`;
  `lib/db/turso.test.ts`; `scripts/pull-remote.test.ts`;
  `scripts/refresh-script.test.ts`; `lib/send.test.ts`;
  `app/api/send/route.test.ts`; `app/layout.tsx`; test mock/env/temp/network
  call-site searches. Requested `claude-mem:do`, dynamic-workflow-mode and
  parallel-execution-optimizer skill contracts were read; this worker does
  not spawn nested agents or authorize the later commit/sync roles.
- Environment evidence: existing DB tests use `:memory:`/unique temporary
  `file:` databases; mail tests stub the transport; refresh dispatch tests
  stub fetch. Gate enforcement denies external network (build-only compiler
  loopback) and isolates HOME/TMPDIR, npm configuration/cache and default DB
  location. Original `.env.local` and `node_modules` are neither loaded nor
  copied. Every invoked process/session completed before handoff.

| Command | Result |
| --- | --- |
| `git status --short --branch` | Clean `HEAD (no branch)` at entry |
| `git show -s --format='%H%n%D%n%s%n%ci' HEAD` | Baseline SHA above |
| `git branch --list 'DY/workie-auto-apply*' --format='%(refname:short) %(objectname) %(worktreepath)'` | No existing matching branch |
| `git switch -c DY/workie-auto-apply` | Exit 0; new branch created |
| `cp -n /Users/dyl/Workie/plans/auto-apply.md plans/auto-apply.md` | Exit 0; unchanged source copy |
| `cp -n /Users/dyl/Workie/HANDOFF.md HANDOFF.md` | Exit 0; unchanged source copy |
| `cmp /Users/dyl/Workie/plans/auto-apply.md plans/auto-apply.md` | Exit 0; byte equality |
| `cmp /Users/dyl/Workie/HANDOFF.md HANDOFF.md` | Exit 0; byte equality |
| Isolated `npm ci` (exact wrapper in workflow doc) | Exit 0; 405 packages in 8m; lockfile unchanged |
| `npm test` | Exit 0; 42 files, 1,246 tests passed on both baseline runs |
| `npx tsc --noEmit` | Exit 0 on both baseline runs and focused gate |
| `npm run lint` | Exit 0; existing `lib/auto-apply.test.ts:27-28` unused `tick`/`idle` warnings; no errors |
| `npm run build` | Exit 1 after compiler-IPC correction: `Failed to fetch` Archivo `from Google Fonts`; external network denied |
| `git diff --check` | Exit 0 |
| `node --check scripts/auto-apply-gate.mjs` | Exit 0 |
| `node scripts/auto-apply-gate.mjs --self-test` | Exit 0, including compiler loopback and external-network denial |
| `node scripts/auto-apply-gate.mjs phase 0 lib/auto-apply.test.ts app/board-storage.test.ts` | Exit 0; 2 files, 24 tests, typecheck/lint/diff passed |
| `node scripts/auto-apply-gate.mjs full` | Expected exit 1, BLOCKED/NOT RUN: missing `test:worker`, `test:documents`, `test:e2e` |

Authoritative corrected baseline invocation:
`node scripts/auto-apply-gate.mjs baseline` (exit 1).
Its command logs and results are in
`logs/auto-apply-gate/baseline-DiZPQC/`. Recorded command wall times:
tests 2.719s, typecheck 2.919s, lint 2.535s, build 3.081s, diff 0.036s.
The build's remaining error is
`[next]/internal/font/google/archivo_dcbbed32.module.css`, caused by denied
access to Google's font stylesheet. `app/layout.tsx` imports `next/font/google`.
No font substitution, network relaxation or application refactor was made to
claim a passing build. At this stage a successful production build was NOT
established; the later independent qualification below establishes it only
with network enabled for normal public fonts, not as an offline baseline pass.

Focused gate logs: `logs/auto-apply-gate/phase-OL447x/`. These 24 tests cover
existing search-filter/manual-storage behavior, not application execution.
Full worker/document/browser checks are NOT RUN and have no pass evidence.

First baseline logs: `logs/auto-apply-gate/baseline-yAfDgj/`, including
`results.json` and each command's output. Build failed at
`app/globals.css` processing with `binding to a port / Operation not permitted
(os error 1)`. This was caused by the new harness denying compiler IPC, not
an established application regression. The correction permits build-only
loopback using separate bind/inbound/outbound rules. A local echo plus denied
`192.0.2.1:443` TEST-NET probe passed; a broader combined-filter probe was
rejected because it did not deny the external test socket. No production
endpoint was used. The qualified boundary probe is now in `--self-test`.

Dependency notes: npm reported deprecations for locked
`@esbuild-kit/esm-loader@2.6.5` and `@esbuild-kit/core-utils@3.3.2`; no upgrade
was attempted. Installed Next 15.5.25, React 19.1.0, TypeScript 5.9.3,
Vitest 4.1.10, Drizzle ORM 0.45.2, Drizzle Kit 0.31.10, libSQL client 0.17.4
and better-sqlite3 13.0.3 match their lockfile entries. Package/lockfile and
both preserved-input SHA-256 values match the pre-install values above.

`git diff --check` excludes untracked files. Each new authored file was also
checked with `git diff --no-index --check /dev/null <file>`: exit 1 denotes
added content, with no whitespace diagnostics. No files were staged.

Proof boundary: source inspection and synthetic/local checks only. No live
provider probe, real mail, browser login, real-data migration, production
ingestion/mirroring, resource provisioning, deployment or employer submission.
No schema/protocol/support-matrix implementation version exists yet.
Existing test output labels such as `production-link-audit` and
`refresh-request-done` are mocked fixture events, not live operations.

## Historical Phase 0 Next-Step Contract

Superseded by the current header and accepted Phase 1 proof below.

1. Parent acceptance and review closure are complete. The authorized commit
   contains only `plans/auto-apply.md`, `docs/auto-apply-progress.md`,
   `docs/auto-apply-workflow.md`, and `scripts/auto-apply-gate.mjs`.
   Keep `HANDOFF.md` untracked/unstaged; exclude private inputs, logs, DBs and
   environment files. No push is authorized.
2. Retain the accepted offline font-fetch limitation. The separately qualified
   production build does not turn the failed offline baseline into a PASS or
   authorize general egress, production access or release.
3. Phase 1 is ready but not started. Once assigned, its owner re-reads R1/R5/R6/R9 and D1/D2,
   confirms current status/ref and installed API signatures, and owns the private
   storage/auth surfaces. Use synthetic mail and separate scratch databases.
4. Before HTTP/browser fixture tests, qualify isolated fixture ports and tools;
   test commands currently deny even loopback. Build-only host-wide loopback
   is for compiler IPC, not permission to reach personal provider services.
5. No `send_message_to_thread` in any namespace/wrapper; no nested agents.
   No additional commit, push or phase implementation without authorization.

## Bounded Phase 0 P2 Fix: Empty-Test Failure

Historical fix record; pending acceptance statements below are superseded by
Parent Acceptance.

- September 20, 2026. Scope: this appended record and
  `scripts/auto-apply-gate.mjs` only.
- Cause: baseline used plain `npm test` despite Vitest's
  `passWithNoTests: true`; full inherited that false-green risk.
- Added self-test assertions that baseline and full npm-test argv each include
  `--passWithNoTests=false`, before changing the command.
- Before: `node scripts/auto-apply-gate.mjs --self-test` exited 1 at the
  baseline assertion. A read-only in-memory copy omitting only that assertion
  exited 1 at the full assertion; neither probe ran the command gates.
- Fix: baseline argv changed from `['test']` to
  `['test', '--', '--passWithNoTests=false']`; full inherits the fix.
- After: `node scripts/auto-apply-gate.mjs --self-test` and
  `node --check scripts/auto-apply-gate.mjs` both exited 0.
- Gate source SHA-256 before:
  `a5b7819080d90e976a9eb144f973397d1c813419f0a213ef915054715cd5c675`.
- Gate source SHA-256 after:
  `ca098d43a17f05e3bc8eaef4fab788a0d87fcfee8850a0049cfdfaea0588c4e8`.
- Baseline, full, typecheck and build were NOT RUN for this fix; independent
  verifier outputs, including `.next`, were untouched.
- Independent verification and review remain PENDING. Phase 0 is NOT ACCEPTED.
  No nested agents, cross-task messaging, commits, pushes, production or
  credential actions were performed; the original checkout was not modified.

## Bounded Phase 0 P2 Fix: Normalized CLI Option

Historical fix record; pending acceptance statements below are superseded by
Parent Acceptance.

- September 20, 2026. Authored changes: gate imports (lines 4-5), normalized
  filename guard (line 23), regression (lines 89-95), and this appended section.
  `focusedFile` now rejects `local.startsWith('-')`; all existing guards and
  focused/baseline/full `--passWithNoTests=false` behavior remain intact.
- Regression creates an exclusive, UUID-named root `--config=<uuid>.test.ts`
  fixture, passes it as `./--config=<uuid>.test.ts` through phase command
  selection, and removes it in `finally`. Before the guard fix, self-test
  exited 1: `BLOCKED: Missing expected exception.` Afterward it exited 0.
  Separate directory checks confirmed cleanup after both failure and success.
- Runtime: `/Users/dyl/.nvm/versions/node/v22.23.2/bin/node`.
  `--check scripts/auto-apply-gate.mjs` and
  `scripts/auto-apply-gate.mjs --self-test` both passed.
  `scripts/auto-apply-gate.mjs phase 0 lib/auto-apply.test.ts app/board-storage.test.ts`
  passed: 24 tests, typecheck, lint (only existing unused `tick`/`idle` warnings),
  and diff check. [Focused results](../logs/auto-apply-gate/phase-eHFm1Z/results.json).
- Gate SHA-256 before:
  `ca098d43a17f05e3bc8eaef4fab788a0d87fcfee8850a0049cfdfaea0588c4e8`;
  after: `3926e07f3d8565cc76ecfa77b37f6c17ca76b791d9fcffaa97f0b89aea5b9f7d`.
- Reviewed existing [independent qualification](../logs/auto-apply-gate/verification-K5dFOm/results.json):
  1,246 baseline tests, focused 24/typecheck/lint, and network-enabled
  `npm run build` passed. This qualifies the earlier build uncertainty only;
  it does NOT turn the deliberately blocked offline font-fetch baseline into
  a pass. Full integration remains NOT RUN: required worker/document/e2e
  scripts are absent. No build rerun or font changes were made for this fix.
- Ready for parent acceptance; Phase 0 is NOT ACCEPTED. Existing WIP preserved;
  package/lockfile and preserved-input hashes unchanged. No app edits, nested
  agents, cross-task messages, commits, pushes, credentials or production actions.

## Historical Phase 0 Parent Acceptance

- September 20, 2026: parent independently accepted Phase 0 after verification
  and review closure; Phase 1 is READY, NOT STARTED.
- Evidence: `logs/auto-apply-gate/verification-K5dFOm/results.json` records
  1,246 tests, focused 24/typecheck/lint, harness self-test and an actual
  production build passing. Build network was enabled solely to obtain normal
  public Google Fonts. This is build qualification, not production deployment
  or proof that the externally network-denied baseline passes.
- Parent rechecked both reviewer fixes: baseline/full
  `--passWithNoTests=false` and normalized option-filename rejection.
  Later fix checks and focused evidence are recorded above.
- Accepted final gate SHA-256:
  `3926e07f3d8565cc76ecfa77b37f6c17ca76b791d9fcffaa97f0b89aea5b9f7d`.
- Offline baseline retains its deliberate Google Fonts failure. Missing
  worker/document/e2e suites are NOT RUN, not passing. No production release,
  submissions or Phase 1 implementation is authorized.
- Parent explicitly authorized the four-file commit listed above on
  `DY/workie-auto-apply`, from HEAD
  `a68c3fadeca161c6d44ca337ba073ffea50a9e13`; no push.

## Phase 1 Lane A: Private Storage

September 20, 2026: explicit Phase 1 lane-A assignment implemented; independent
parent acceptance remains pending. Starting/ending HEAD:
`88cea14e13865474a248ce8673befc1be9d2f394` on `DY/workie-auto-apply`.
Historical Phase 0 status/authorization text above is not rewritten by this lane.

- Owned changes: `lib/private-db/{config,index,schema}.ts`, storage/HTTP tests;
  `drizzle-private/0000_private_auth.sql` and metadata;
  `drizzle-private.config.ts`, `scripts/private-migrate.ts`, package/lockfile,
  `.env.example`, this lane-A record, and ignored readiness/evidence files.
- APIs match the agreed contract: `PrivateDb` has the async libSQL API and
  `$client.close()`; `openPrivateDb(config, guards?)`, lazy `getPrivateDb()`,
  explicit async `migratePrivateDb(db)`, sanitized `PrivateConfigurationError`.
  Schema exports `user`, `session`, `account`, `verification`, `rateLimit`.
- Explicit private config in local/hosted modes; no corpus fallback. Validation
  precedes any client/file creation, resolving symlinks, dangling links,
  hard-link identity, case aliases and symlink/`..` corpus paths. HTTPS/libSQL
  aliases of the corpus host are rejected. URLs cannot carry embedded tokens,
  credentials, fragments or TLS-disable query parameters. Plain HTTP is only
  accepted for explicit numeric-loopback fixtures; Vercel requires HTTPS.
  Remote TLS targets require `WORKIE_PRIVATE_DATABASE_AUTH_TOKEN`.
- New local files use `0600`; existing group/other-readable files are rejected.
  Operators must select a private parent directory. Import/get/open never
  migrate. Only `db:private:migrate` opens a configured target and migrates it;
  `db:private:generate` has no database credentials and only generates files.
- Auth dates use `timestamp_ms`, emailVerified is boolean, lastRequest is a
  plain numeric integer; string IDs, session/email/rate-key uniqueness,
  cascading parent FKs and boolean/rate-number checks are active.
  Verification identifiers have a nonunique index. No future worker tables/hooks.
- Sources read: architecture and Phase 1 only; R1/R5/R6 corpus drivers,
  migrations, push/pull and refresh-cache workflow; D1/D2 v1.7.5 Drizzle/rate
  docs; pinned official CLI `auth-schema-sqlite.txt` generated snapshot and
  generator; installed Better Auth `getAuthTables`, adapter types/source,
  Drizzle libSQL driver/migrator and libSQL/Hrana sources. The schema adapts the
  pinned snapshot's core fields, with runtime date defaults and numeric
  rate-limit fields from installed types. Drizzle Kit generated SQL/metadata;
  no Better Auth CLI import of live app configuration was performed.
- Exact pinned installs used the workflow's isolated HOME/npm config/cache and
  existing Node `v22.23.2`: scoped `npm install --save-exact better-auth@1.7.5
  @better-auth/drizzle-adapter@1.7.5 server-only@0.0.1`. npm initially hoisted
  newer Zod; a scoped `zod@4.4.3` install restored the application version,
  leaving auth's required versions nested. Root manifest range preserved.
  Structured lock comparison proves every preexisting package version is
  unchanged and no prior package was removed; package/lock dependencies agree.

| Check | Result / Evidence |
| --- | --- |
| Tests first | Initial missing-module failure; subsequent relative-file, file-permission and symlink/`..` regressions observed failing before their fixes |
| `node scripts/auto-apply-gate.mjs phase 1 lib/private-db/index.test.ts` | PASS: 35 tests, `tsc --noEmit`, lint (only two baseline warnings), diff check; `logs/auto-apply-gate/phase-eETD47/results.json` |
| Real file libSQL | Fresh and existing-state migration, repeat/reopen preservation, async commit/rollback across awaits, date round-trips, parent FKs and constraints passed |
| Migration CLI | Missing config exits 1 without a file; explicit scratch URL twice exits 0; recorded migration and empty auth table verified |
| Corpus boundary | Scratch push/pull/cache checks pass; private file bytes/rows unchanged, restored corpus has no private tables, actual cache paths archived/inspected without private canary |
| HTTP fixture | 1 test PASS: real SDK HTTP requests, migration/commit/rollback to a loopback Hrana v2 fixture backed by scratch libSQL; `logs/auto-apply-gate/phase1-db-http-tests.json` |
| Network qualification | Loopback-only sandbox allowed the fixture; external `192.0.2.1:9` returned `EPERM` |
| Private generation rerun | PASS: Drizzle Kit 0.31.10 reports no schema changes |
| Existing corpus files | `git diff --exit-code HEAD -- lib/db drizzle drizzle.config.ts scripts/push-remote.ts scripts/pull-remote.ts .github/workflows/refresh.yml` PASS |

HTTP verification uses the same clean environment as the workflow, with the
following sandbox network rules instead of its tests-deny-all rule:

```text
(deny network*)
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "localhost:*"))
(allow network-bind (local ip "localhost:*"))
```

File writes remained restricted to this worktree and `/dev/null`. The test
binds only its own ephemeral `127.0.0.1` port. This is host-wide loopback
permission, not per-port isolation. Run `node node_modules/vitest/vitest.mjs
run lib/private-db/http.test.ts` with that qualified profile; it is local
protocol evidence, **not a real Turso service test**. The unchanged Phase 0
harness denies test loopback, so the parent must explicitly account for this
fixture when running the final combined gate, not silently skip it.

Readiness: `logs/auto-apply-gate/phase1-db-ready.json`. No API signature drift.
Lane B edits were preserved; no `.next` build, nested agents, cross-task
messaging, commits, pushes, real credentials/mail/model calls, production
ingestion/mirroring/migrations, provisioning or deployment occurred.
Never use `send_message_to_thread` in any namespace/wrapper for handoff.

## Phase 1 Bounded Integration: Migration Path

- September 20, 2026; `DY/workie-auto-apply` at `88cea14`.
  Turbopack treated the migration directory `new URL(..., import.meta.url)`
  as an unresolved asset even though migrations are explicit-only.
- `lib/private-db/index.ts` now imports `dirname`/`join` and resolves
  `join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle-private')`,
  matching the public DB pattern. No migration trigger or DB semantics changed.
  The existing CLI test now invokes the absolute script from a scratch cwd,
  checking missing config, repeat migrations and the configured scratch target.
- Node `v22.23.2`, sanitized HOME/TMP/npm config, scratch WORKIE_DB, no local
  environment files. Storage/auth/mail: 56 tests PASS with all network denied;
  HTTP fixture: 1 test PASS with loopback-only networking. External TEST-NET
  probe returned EPERM. `tsc --noEmit --incremental false`, focused ESLint and
  `git diff --check` PASS. Build-only network permission follows Phase 0 solely
  for normal public Google Fonts; fonts and dependencies were not edited.
- Actual `npm run build` before: exit 1, migration-directory resolution error
  plus `@libsql/hrana-client/LICENSE:1:5` ECMAScript parse error. After: exit 1,
  only the same LICENSE parse error remains. Build is NOT passing.
- Exact commands, sanitized environment, policies and results:
  `logs/auto-apply-gate/phase1-integration-Y1NNn0/{commands,results}.json`;
  before/after build logs: `before-build.log`, `build.log` in that directory.
  Other WIP and the original root are preserved. No full future integration
  scripts, production services/data, real mail/models/ATS, credentials,
  cross-task messages, nested agents, commits or pushes. Phase NOT ACCEPTED;
  remaining build error and independent review require follow-up.

## Phase 1 Bounded Integration: Server Externalization Check

- No build fix retained. Checked official Next v15.5.25
  `serverExternalPackages.mdx` and `crates/next-core/src/next_server/{context,resolve}.rs`
  in `vercel/next.js`, plus installed libSQL exports and native loader.
  Next already auto-externalizes `@libsql/client` and `libsql`; generated server
  chunks confirm the client is external. Externals are still dependency-traced.
  The native loader's dynamic `require('@libsql/' + target)` is the suspected
  overbroad trace path to Hrana's LICENSE, not an application import of a license.
- Two actual clean `npm run build` experiments failed with the identical
  `@libsql/hrana-client/LICENSE:1:5` parse error: adding only
  `@libsql/hrana-client`, then explicitly listing `@libsql/client` and `libsql`.
  Restored `next.config.ts` exactly; `lib/private-db/index.ts` was not edited.
  No license exclusions, dependency changes, tracing bypasses or client fallbacks.
- Node 22.23.2, exact installed dependencies, clean environment from
  `verification-K5dFOm/commands.json`, scratch HOME/TMP/WORKIE_DB, no `.env` files:
  56 offline storage/auth/mail tests PASS; one loopback HTTP test PASS;
  `tsc --noEmit --incremental false`, focused ESLint and `git diff --check` PASS.
  Build-only network permission used the existing Google Fonts build recipe.
- Bounded production start on `127.0.0.1:59422` exited 1 with
  `production-start-no-build-id`; PID 71459 exited and no server was retained.
  `/sign-in` 200 and `/api/auth/applicant` 503 remain UNVERIFIED because there is
  no successful production build. Phase remains NOT ACCEPTED.
- Reproducible checks and full commands/results/logs:
  `logs/auto-apply-gate/phase1-build-boundary/verify.mjs`,
  `{commands,results}.json` and `build.log` (Hrana-only attempt),
  `explicit-native-build-{commands,results}.json`, `explicit-native-build.log`,
  `checks-{commands,results}.json`, and `production-server.log`.
  Original root, cache headers, corpus behavior and other workers' changes
  preserved. No nested agents, cross-task messages, commits/pushes, credentials,
  SMTP/model/ATS calls or production actions.

## Phase 1 Review-Fix Coordination

Parent gate: NOT ACCEPTED. Last committed/pushed revision remains `88cea14`.
Phase 2 and later implementation have not started. The original main checkout,
production configuration and real applicant data remain outside the write scope.

Independent security and code-quality reviews identified these required fixes:

- Dynamic reset callback paths create distinct rate-limit buckets.
- The unused revoke-other-sessions endpoint can miss sessions after 100 rows.
- Generic auth success bodies discard upstream cookie-deletion headers.
- The private applicant lookup bypasses the SDK HTTP limiter.
- Reset-token removal prevents a valid unfinished reset from surviving reload.
- Expired verification callbacks can display a conflicting success message.
- Private authentication pages need HTTP frame protection.
- The Turbopack native dependency trace still prevents a production build.

Active, non-overlapping assignments:

| Lane | Native Agent ID | Write Surface | Handoff |
| --- | --- | --- | --- |
| Backend fixes | `01a0c151-5e71-71c2-9859-45f92b9c4cd5` | Auth services, access guard, auth routes and backend tests | `logs/auto-apply-gate/phase1-backend-fixes-ready.json` |
| UI fixes/tests | `01a0c151-617f-7983-a597-410c0e1833ad` | Sign-in UI, rendered auth tests and auth Playwright config | `logs/auto-apply-gate/phase1-ui-code-ready.json` |
| Build/headers | `01a0c151-64b5-7fb2-b48c-aa6ed6d7caeb` | Private driver import boundary, Next config, package files, browser dependency | `logs/auto-apply-gate/phase1-build-ready.json` |

UI publishes source readiness before awaiting the build. The final build follows
both source-readiness markers; UI browser checks then use that completed build.
No overlapping builds or personal browser profiles. These markers are not phase
acceptance: combined verification, review closure, commit and branch sync remain.

The existing web Drizzle facade accepts a supplied Client and uses the same
constructor as the root facade. The build lane is qualifying this smaller
boundary correction without losing native file/HTTP support. Plain external
package additions already failed and must not be replayed as an untested fix.

Toolchain discovery for later phases found bundled Python 3.12.14 with pypdf
6.10.0, pdfplumber 0.11.9 and Pillow 12.3.0; Poppler 26.03.0 and a local Docker
29.6.2 daemon are available. The LibreOffice launcher is broken and browser
binaries were not installed at inspection. These are prerequisite observations,
not document-fidelity, sandbox-isolation or ATS-submission proof.

Never call `send_message_to_thread` in any namespace or wrapper. Read-only task
inspection, native completion/wait, and these handoffs are the coordination paths.

## Phase 1 Final Regression And Runtime Recovery

The backend security recheck passed after removal of dynamic reset callbacks and
the unused incomplete session-revocation endpoint, preserved deletion cookies,
HTTP-limited applicant lookup, and actual frame/no-store headers. The standard
Next 15 webpack dev/build path replaced the verified failing Turbopack path;
native file and HTTP private clients remain supported.

Code review then required a same-mode reset-token race fix and stricter UI
coverage validation. Current source includes request-generation/lifetime/live-URL
guards and an exact 14-case, two-project report validator, plus the three
EOF-only whitespace corrections. Negative tests reproduced eight old-build
failures and rejected twelve incomplete reports plus an actual `.only` suite.
The earlier 89-test filtered build check included nonexistent filters and is
not full coverage; the 1,311-test, 46-file inventory supersedes that evidence.

The final current-source build and 1,311-test suite passed, but its last UI run
was interrupted after 14 mobile passes when generated dependencies, Chromium,
build output and npm cache disappeared. The strict validator rejected this
partial run; `phase1-build-ready.json` was marked `buildReady:false`.
No phase acceptance or feature commit followed the interrupted run.

Read-only inspection identified the completed `Audit laptop storage` task as
the cleanup source. It had separate user approval and finished before recovery.
Its instructions do not authorize any further deletion here. Workie source,
package lock, user handoff and saved test evidence remain intact.

Recovery assignments:

- `01a0c17f-333d-7021-a903-8e4d731c0a37`: restore exact locked dependencies and
  matching Chromium only, then rerun full tests/types/lint/build/strict 28-case UI
  verification with fresh evidence. No source changes or cloud/private actions.
- `01a0c17f-3460-7733-bd1b-6f559efe443f`: read-only closure review of the latest
  reset-lifetime and test-harness corrections.

Current-code report before recovery:
`logs/auto-apply-gate/phase1-final-corrective/final-report.json`.
Phase 1 remains NOT ACCEPTED; phases 2-12 remain NOT STARTED. Do not substitute
the earlier corrective revision's 28-case pass for the interrupted final run.

## Phase 2 Active Assignments

Phase 1 subsequently passed recovered verification and was committed/pushed as
`d4e3a9cc83a4cecabd606fb39d6ce25a7fd83fed`. Its acceptance record supersedes
the historical interrupted-run status above.

| Lane | Native Agent | Exclusive Scope | Handoff |
| --- | --- | --- | --- |
| Profile/policy backend | `01a0c191-465a-79b2-82a9-602915ce5229` | Profile/policy schemas, stores, routes, draft-key route, root private schema/migrations, package files | `logs/auto-apply-gate/phase2-profile-contract.json`, then `phase2-backend-ready.json` |
| Document backend | `01a0c191-47de-76b2-8689-256db5e576b3` | Document schema module, grants, storage, validation, routes and tests | `phase2-doc-schema-ready.json`, `phase2-doc-contract.json`, then `phase2-documents-ready.json` |
| Profile UI | `01a0c191-48b3-7390-a8d0-8f626017dd3a` | Profile/policy/document screens, encrypted draft lifecycle, rendered tests | `phase2-ui-code-ready.json` |

All handoffs above are under ignored `logs/auto-apply-gate/`. Backend owns all
schema generation and dependency installation; document and UI lanes consume
its published contracts without competing edits. UI publishes source readiness
before any final build. No current lane may commit, push, enable production
submissions, use real applicant data, or call cross-task messaging.

## Accepted Phase 1 Proof And Handoff

The parent explicitly accepted Phase 1 after independent security PASS
(`01a0c163-0af2...`, parent-supplied identifier), final quality PASS
(`01a0c17f-3460-7733-bd1b-6f559efe443f`) and recovered verification PASS.
The report's `phaseAccepted:false` records the verifier's earlier boundary;
acceptance comes from this subsequent parent assignment, not a rewritten report.

| Proof | Accepted result / source |
| --- | --- |
| Authoritative recovered gate | `logs/auto-apply-gate/phase1-recovered-NfBWjH/final-report.json`: 1,311 tests / 46 files, zero failed/skipped/todo; types, lint and build PASS |
| Rendered UI / validator | Strict 28 PASS: 14 identities each at mobile390/desktop1440; 12 negative reports and actual `.only` rejected; `logs/auto-apply-gate/phase1-ui-HfJvVQ/summary.json` |
| Source / invocation provenance | Recovered directory: `build-inputs.json`, `commands-results.json`, `evidence-sha256.json`; source hash `659794b5e00955ad5b4292b93ecb90b39b11c77d4414f8e2fac549fdbf6fee91`, build `7-3EkFctvZVvDeAE5VkSK` |
| Cleanup / warnings | No remaining processes/listener or unexpected corpus DB; two baseline unused-variable warnings plus two historical ignored-fixture warnings, not new app warnings |

Proof is local/synthetic: real scratch libSQL transactions/migrations and
loopback SDK HTTP, with simulated auth responses in rendered UI. Real cloud
DB and SMTP remain UNVERIFIED. Next 15 default webpack build passed with normal
public-font network access after Turbopack native-loader tracing failed.
The unchanged setup gate still denies test loopback and requires absent future
full scripts; it did NOT produce this combined Phase 1 PASS. Use the qualified
invocations and limitations in `auto-apply-workflow.md`.

Only this ledger and the workflow receive acceptance edits after verification;
historical logs are preserved. Phase 2 owns profiles/policies/documents; Phase 3
owns worker-security revocation. Reuse the private migration and auth API contracts
in the workflow. Keep `HANDOFF.md` untracked and exclude logs, databases and
secrets. Commit only the authorized Phase 1 surfaces; no push in this role.

## Phase 2 Resume After Interruption

Resumed September 20, 2026, local Pacific time. Branch remains at `d4e3a9c`;
Phase 2 changes are uncommitted. Prior integration/review workers were shut down
by the interruption. No worktree test/server process was found on resume.

The compiled parser baseline reproduced a real failure: every synthetic file,
valid or invalid, remained quarantined/deferred. Its `passed:true` meant the
baseline reproduction completed, not that document validation worked.
`phase2-parser-baseline-proof.log` is not a feature acceptance result.

| Resumed lane | Native agent | Work and gate |
| --- | --- | --- |
| Applicant precondition | `01a0c1df-a365-77a3-baa9-d2eeb7216577` | Finish partially written `x-workie-applicant` rejection guard and real-session tests; preserve authenticated ownership |
| UI review corrections | `01a0c1df-a585-7cb3-aa0f-6b8c88944062` | Policy retry/current-head/disable recovery, nullable controls, cross-field errors and consumed-upload reconciliation |
| Production parser/build | `01a0c1df-a72f-7570-b4f1-b941fcf4f4b9` | Static parser runtime/trace fix and actual compiled plus isolated-package proof |
| Security recheck | `01a0c1df-a9e8-7e21-904d-7b4746ab8b0b` | Read-only review of stable Phase 2 trust boundaries; prior interrupted review had no final result |

UI review has seven open P2 findings, assigned to the UI lane above:
historical policy acknowledgements displayed as current; POST retries discarding
newer edits; uncertain requests preventing disable; optional address clearing
producing invalid null; no nullable pay-floor reset; unrendered entry/section
validation errors; and retries sending bytes to already-consumed upload grants.
The all-sections and policy fixtures also need to match actual backend validation.

Final build follows both principal and UI-fix source-ready markers. Review closure,
full suite, exact rendered test matrix and compiled parser verification are required
before Phase 2 acceptance, commit or working-branch sync. No production actions.

## Accepted Phase 2 Proof And Handoff

September 20, 2026 (Pacific): the parent explicitly accepted Phase 2 and authorized
this commit-only role. `logs/auto-apply-gate/phase2-final-verification.json` records
`status: "PASS"`, `passed: true`, and no blockers; its earlier
`phaseAccepted: false` / `parentAcceptance: "pending"` remain unchanged.
Acceptance comes from the subsequent parent authorization, not a rewritten report.

| Proof | Accepted result / qualification |
| --- | --- |
| Final independent checks | 1,406/1,406 tests in 53 files; types and whitespace PASS; lint: zero errors, two unchanged `tick`/`idle` warnings |
| Compiled UI | 128/128 identities: 32 cases x mobile390/desktop1440 x light/dark; zero skips, failures, retries or flakes; mocked profile/document APIs |
| UI validator / visuals | 13 negative checks; 144 nonblank native-size captures, ten representative captures visually reviewed, not all tiles or a full accessibility audit |
| Retained parser HTTP proof | Compiled `phase2-parser-production-8QwXFA/summary.json` and isolated-package `phase2-parser-production-gR3Cos/summary.json`, both under the ignored gate: 21 cases each, seven available downloads and 14 rejections |
| Review closure | Parent-reported PASS: Huygens full security; Sartre ZIP closure (`01a0c1fc-b539`); Faraday seven UI fixes (`01a0c1ef-f6a5`); Aristotle bounded tests/CSS review (`01a0c23a`) |

Final build: `jBCMvyfH_MA6ppWp2H8dm`; accepted source SHA-256:
`46f590d4afd3738b285019d64f3f23b4067f7ac3d197199456dcd100db800836`.
The 263-file manifest is `logs/auto-apply-gate/phase2-ui-rendered-build.json`.
Parser HTTP proofs used prior build `9a_Fe5h66hiHF_Bya8uEM`, not a final-build
rerun. Five compiled document routes are byte-identical; sorted trace lists and
parser/native files match, with generated module-ID/order differences qualified
in the report. Only three mobile CSS rules and test/harness files changed since
that parser source. This is same-backend-component evidence, not live-service proof.

The final verifier recorded unchanged source/build hashes, stopped sessions and
listeners, removed synthetic scratch, no corpus creation and preserved historical
evidence. Its initial fixture-write sandbox failure and normal no-index exit-code
correction remain recorded; the corrected full run passed without source edits.
No tests or builds are rerun by this commit role. Only these two acceptance docs
change after verification; retained proof is not a docs-inclusive rerun.

Phase 3 is READY, NOT STARTED. Its assigned owner must reread plan Phase 3
(R7/R5, D4/D7), preserve authenticated ownership, versioned profile/policy
contracts and immutable document masters, and implement pairing/worker revocation,
fences and durable checkpoints with synthetic isolation proof. Auto Apply is not
finished; worker, ATS, document-generation and release gates remain outstanding.
Commit only the authorized Phase 2 surfaces plus these two docs; keep `HANDOFF.md`
untracked and exclude logs, databases and real environment files. Record the
commit SHA/files/exclusions in ignored `logs/auto-apply-gate/phase2-commit.json`.
No push, main changes, deployment, real applicants, submissions, nested agents or
`send_message_to_thread` in any namespace/wrapper.
