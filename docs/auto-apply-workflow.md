# Auto Apply Task-Local Workflow

Date: September 20, 2026. Scope: the approved plan's implementation, beginning
with Phase 0 branch/setup and baseline. This file is the operating contract;
`auto-apply-progress.md` is the single phase/evidence ledger. No repository ECC2
configuration or state-store scripts were found during the Phase 0 scan.

## Objective And Inputs

- Implement only the phase assigned by the parent operator, prove it with
  synthetic checks, record the result, and return through native completion.
- Source inputs: `plans/auto-apply.md`, `HANDOFF.md`, current source, lockfile,
  `README.md`, and `.github/workflows/verify.yml`. Re-read the relevant plan
  references each phase; copied source claims are not current runtime evidence.
- Write root: `/Users/dyl/.codex/worktrees/workie-auto-apply/Workie`.
  `/Users/dyl/Workie` is read-only. Translate every proposed source-root path
  in the preserved plan/handoff to the write root before acting.
- Both documents are byte-for-byte source copies. Do not edit their original
  paths or rewrite the copies merely to change absolute links.
- Branch: `DY/workie-auto-apply`. Shared Git branch metadata is necessarily
  updated by the explicitly requested branch creation; original source files,
  dependencies, credentials, and databases are not modified.

## Safety And Ownership

- Never call `send_message_to_thread`, `codex_app.send_message_to_thread`, or
  `mcp__codex_app.send_message_to_thread`, including wrappers. Include this
  restriction in every worker assignment. No nested agents. Use native
  completion/wait or this handoff ledger; never replay malformed tool history.
- Preserve others' WIP. Inspect status/ref before editing. Only the assigned
  role writes its surface; package/lockfile, schema, shared headers and CI
  changes require one integration owner and sequential writes.
- Tests use synthetic applicants, in-memory/file scratch databases and mocked
  transports. No original `.env.local`, credential loading, private histories,
  real resumes, browser login, inference, real mail, or employer submissions.
- No production ingestion/mirroring, real database migrations, provisioning,
  deployment, service installation, or scheduler changes. GitHub Actions remains
  the sole production corpus writer; private state must use a separate database.
- Phase 0 independent verification and review closure are parent-accepted.
  The parent explicitly authorized only the four-file commit:
  `plans/auto-apply.md`, `docs/auto-apply-progress.md`,
  `docs/auto-apply-workflow.md`, and `scripts/auto-apply-gate.mjs`.
  Keep `HANDOFF.md` untracked/unstaged; never stage private inputs, logs, DBs
  or environment files. No push, production release or submissions.
  Phase 1 is READY, NOT STARTED; implementation requires a separate assignment.
  Repository release conventions do not themselves authorize a release.

## Repeatable Checks

The plain Node runner uses fixed command/argv lists with `shell: false`. It
prints each package script body and real exit/signal result, records raw output
and `results.json` under ignored `logs/auto-apply-gate/`, and exits nonzero if
any check fails. It never installs dependencies, starts app/worker services, provisions
resources, migrates live data, commits, pushes, or marks a phase accepted.

```bash
node scripts/auto-apply-gate.mjs --self-test
node scripts/auto-apply-gate.mjs baseline
node scripts/auto-apply-gate.mjs phase 0 lib/auto-apply.test.ts app/board-storage.test.ts
node scripts/auto-apply-gate.mjs full
```

- `baseline`: `npm test -- --passWithNoTests=false`, `npx tsc --noEmit`, `npm run lint`,
  `npm run build`, then `git diff --check`; all commands are attempted even
  when an earlier command fails.
- `phase N <test-file...>`: existing explicit in-worktree test files only,
  with `--passWithNoTests=false`, followed by typecheck, lint and diff checks.
  No guessed future paths or empty-test success. It is a focused command gate,
  not proof that the phase's entire acceptance checklist passed.
- `full`: refuses to run if `test:worker`, `test:documents` or `test:e2e`
  is missing; otherwise runs baseline plus all three. Missing checks are
  BLOCKED/NOT RUN, never PASS. A full command pass still needs the plan's
  security, document, browser, support-matrix and independent review evidence.
- `--self-test`: verifies command selection, missing-check rejection, test-file
  boundaries, environment allowlisting, failed/signaled child handling, and
  compiler loopback with an externally denied TEST-NET socket.

The runner rejects worktree `.env*` files other than `.env.example`, and
`.npmrc`, without reading them. Its child environment is an allowlist: Node's
binary directory plus system tools, isolated HOME/TMPDIR/npm config/cache,
CI/telemetry flags, a scratch `WORKIE_DB` and disabled local refresh. Ambient
provider/mail/database credentials, `NODE_OPTIONS` and hosted flags are absent.
An unconfigured scratch database is not seeded or migrated by the runner.

On this Mac the runner requires `/usr/bin/sandbox-exec`, denies external
network, and permits file writes only within the worktree and `/dev/null`.
Only the build gets loopback access for Turbopack compiler IPC; other commands
deny loopback too. This build exception is host-wide loopback, not per-port
isolation. No provider code/configuration is exercised by this baseline.
There is no silent unsandboxed fallback. Existing mocked/file-DB tests can run;
Archivo's build-time Google Fonts download cannot. Record offline build
limitations as environment failures, not invented source defects. Later
HTTP/browser fixture phases must explicitly qualify isolated fixture ports
before changing the test rule; never probe real local services or enable
unrestricted network.

`git diff --check` does not inspect untracked files. Review newly added files
explicitly before the independent gate; do not stage them merely to hide this
limitation. The runner is task-local and macOS-only, not a new cross-platform
test framework or a replacement for CI.

## Accepted Build Qualification

Parent accepted Phase 0 on September 20, 2026 after independent verification
and review closure: 1,246 tests, typecheck/lint, harness self-test, focused
24 tests and an actual production build passed. Evidence is recorded in
`logs/auto-apply-gate/verification-K5dFOm/results.json`; later reviewer-fix
checks are in `auto-apply-progress.md`. Parent rechecked baseline/full
`--passWithNoTests=false` and normalized option-filename rejection against
gate SHA-256 `3926e07f3d8565cc76ecfa77b37f6c17ca76b791d9fcffaa97f0b89aea5b9f7d`.

The successful build used network enabled solely to obtain normal public
Google Fonts. It does not establish an offline build: the network-denied
baseline still fails its Archivo download by design. The gate's network
policy is unchanged; this qualification is not standing permission for
general egress, production access, deployment or employer submissions.
Absent worker/document/e2e suites remain NOT RUN, never PASS.

## Exact Dependency Installation

Phase 0 uses the existing lockfile, Node 22, and no new package scripts.
Run from the write root. Installation may access package distribution
servers; application checks use the externally network-denied gate above.
The separately accepted public-font build qualification is documented above
and does not change the repeatable gate's network policy.

```bash
mkdir -p logs/auto-apply-gate/home logs/auto-apply-gate/tmp logs/auto-apply-gate/npm-cache
/usr/bin/env -i \
  PATH=/Users/dyl/.nvm/versions/node/v22.23.2/bin:/usr/bin:/bin:/usr/sbin:/sbin \
  HOME=/Users/dyl/.codex/worktrees/workie-auto-apply/Workie/logs/auto-apply-gate/home \
  TMPDIR=/Users/dyl/.codex/worktrees/workie-auto-apply/Workie/logs/auto-apply-gate/tmp \
  CI=1 NEXT_TELEMETRY_DISABLED=1 \
  npm_config_cache=/Users/dyl/.codex/worktrees/workie-auto-apply/Workie/logs/auto-apply-gate/npm-cache \
  npm_config_userconfig=/Users/dyl/.codex/worktrees/workie-auto-apply/Workie/logs/auto-apply-gate/user.npmrc \
  npm_config_globalconfig=/Users/dyl/.codex/worktrees/workie-auto-apply/Workie/logs/auto-apply-gate/global.npmrc \
  npm_config_audit=false npm_config_fund=false \
  /usr/bin/sandbox-exec -p '(version 1) (allow default) (deny file-write*) (allow file-write* (subpath "/Users/dyl/.codex/worktrees/workie-auto-apply/Workie") (literal "/dev/null"))' \
  npm ci
```

## Lanes And Handoff

| Lane | Scheduling | Write surface | Gate |
| --- | --- | --- | --- |
| Source/status/lockfile inspection | Parallel reads | None | Current ref, source evidence |
| Dependency installation | Exclusive, before checks | Worktree `node_modules/`, ignored scratch | `npm ci` exit and unchanged lockfile |
| Test/type/lint/build gate | Sequential | Scratch, `tsconfig.tsbuildinfo`, `.next/` | Individual exit results; no active dev build |
| Phase implementation | Dependency-gated | Matrix in progress ledger | Focused checks plus manual acceptance evidence |
| Independent verification/reviews | Read-only; noncolliding checks only | Evidence owned by reviewer | Verification, anti-pattern, quality decisions |
| Branch/sync/release | Explicit later authorization | Git/remote only when authorized | Never automatic |

At each handoff record phase/status, starting/ending HEAD, changed files,
sources actually read, exact commands/results/log paths, fixture versus live
proof, protocol/schema/support versions, blockers and exclusions. Keep secrets
and applicant facts out. Stop dependent work on a failed acceptance gate or
unclear write ownership. Future phases remain NOT STARTED until assigned.
No shared skill extraction is justified yet; consider it only after this
workflow is reused and its eval contract stabilizes.
