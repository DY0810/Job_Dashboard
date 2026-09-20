# Auto Apply Progress

Updated: September 20, 2026.
Current gate: Phase 0 ACCEPTED by the parent after independent verification
and review closure. Phase 1 is READY, NOT STARTED.
Parent accepted 1,246 tests, typecheck/lint, harness self-test, focused 24 tests,
and an actual production build with network enabled solely to obtain normal
public Google Fonts. The offline baseline still FAILS on the denied Archivo
font download by design; future full suites remain NOT RUN because absent.
Only the four-file Phase 0 commit is authorized. No push, deployment,
production enablement, live pilot or employer submission is authorized.

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
| 1: Private storage/auth | 0 | Auth/storage: `lib/private-db/`, `drizzle-private/`, private Drizzle config, auth/access modules/routes | Two-user isolation, real async scratch transactions/migrations, auth/revocation/mail sink, corpus-cache separation | READY; NOT STARTED |
| 2: Profile/policy/documents | 1 | Profile/documents: `app/profile/`, profile schemas, document/policy routes and private schema | All sections, revision/draft isolation, hostile upload checks, immutable masters, disabled policy default | NOT STARTED |
| 3: Pairing/worker | 1-2 | Worker: `worker/main.ts`, state/lease/pairing modules and worker routes | Grants/fences/revocation, process restart/sleep, safe checkpoints, independent waiting work | NOT STARTED |
| 4: Discovery/identity | 1-3 | Discovery: application discovery/run targets, approved shared query extraction, legacy-import flow | 601 jobs, overlap/restart, immutable identities, backlog/caps, confirmed manual suppression | NOT STARTED |
| 5: Questions/bell | 1-4 | Inbox: questions/waiters, inbox/answer routes, `app/notification-bell.tsx`, approved headers | Atomic/idempotent scoped resume, reload/offline drafts, no shared-cache leaks, accessible bell | NOT STARTED |
| 6: Providers/cost | 1-5 | Provider: `worker/providers.ts`, settings/credential/budget modules | Mock protocols, untrusted output, reservation races, unknown cost and remote-fallback denial | NOT STARTED |
| 7: Documents | 2, 5, 6 | Document runtime: `worker/documents/`, synthetic source/PDF fixtures and checks | Qualified PDF/DOCX, unchanged geometry/fonts/links, hostile inputs, parallel scratch isolation | NOT STARTED |
| 8: Greenhouse/Ashby | 1-7 | Browser/ATS: `worker/browser.ts`, `worker/screening.ts`, first adapters/fixtures | Full synthetic receipt flow, answer/intervention/restart, unknown-submit reconciliation, egress | NOT STARTED |
| 9: Lever/Jobvite | 8 | ATS: two adapter/fixture families, support evidence | Date/control/upload regressions, exact-role receipts, unsupported-version blocks | NOT STARTED |
| 10: Workday/Oracle/iCIMS | 9 | ATS: three adapter/fixture families, support evidence | Segmented dates, parsed-fact reconciliation, account/terms/intervention rules | NOT STARTED |
| 11: Applications/operations | 1-10 | UI/integration: applications/settings/navigation, worker commands and operating docs | Responsive light/dark/keyboard, principal-switch/cache, persisted controls, legacy regressions | NOT STARTED |
| 12: Release gate | 0-11 | Verification/docs: `tests/auto-apply/`, verify CI, support/config/recovery/rollback docs | All ten acceptance items; full worker/document/browser tests; independent release authorization | NOT STARTED |

Optional Jev work is excluded and is not a release dependency. Seven ATS
application families and both document paths remain UNIMPLEMENTED/UNVERIFIED.
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

## Next-Step Contract

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

## Parent Acceptance

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
