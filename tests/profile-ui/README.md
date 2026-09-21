# Phase 2 Profile UI Proof

These tests load the real `/profile` Next page. All applicant, profile, policy
and document APIs are explicitly mocked with synthetic values. Unknown APIs,
external requests and public-page prefetches are blocked. This is rendered UI
proof, not authentication, database, document safety, Blob or production proof.

The parser owner builds Next after `phase2-ui-fixes-ready.json` and
`phase2-principal-ready.json` both report `codeReady:true`. The UI runner never
builds. It waits for the parser's `phase2-build-ready.json` with `buildReady:true`,
checks that final build's ID and source hashes, then starts an ephemeral
loopback production server. It reuses the auth runner's sanitized environment,
`.env` rejection, loopback-only sandbox, isolated Chromium path, and cleanup.

From the designated worktree, using the qualified Node runtime:

```sh
/Users/dyl/.nvm/versions/node/v22.23.2/bin/node tests/profile-ui/validate-report.mjs --self-test
/Users/dyl/.nvm/versions/node/v22.23.2/bin/node tests/profile-ui/run.mjs
```

The config has no `webServer` stanza. Expect exactly 32 named cases in each
of four projects (390px/1440px, light/dark): 128 passes, zero skipped, flaky,
focused or unexpected cases. `validate-report.mjs` checks every identity, not
just totals. Its self-test rejects missing, renamed, duplicate and invalid
results. Review the nine-section, document, nullable policy and cross-field
error screenshots. Tall regions use overlapping fixed-viewport PNG tiles,
with numbered suffixes, to avoid blank mobile captures outside the viewport.
The runner saves commands, source/build IDs, strict results,
and server/port cleanup proof under `logs/auto-apply-gate/phase2-ui-fixes-*`.

Fixtures enforce schema-valid profiles, exact authorization country scopes,
policy CAS and original retry acknowledgements, nonempty enablement scope,
idempotent pending grants and consumed-grant rejection. Unknown upload outcomes
are never treated as successful: the file remains selected until its own
document is received, rejected or expired. A still-pending ambiguous upload
requires status reconciliation; these APIs do not expose a safe byte replay.

Focused non-server checks:

```sh
node node_modules/vitest/vitest.mjs run lib/profile-drafts.test.ts --passWithNoTests=false
node node_modules/typescript/bin/tsc --noEmit --incremental false
node node_modules/eslint/bin/eslint.js app/profile lib/profile-drafts.ts lib/profile-drafts.test.ts tests/profile-ui playwright.profile.config.ts
```

Rendered correction ownership also provides an isolated UI-owned rebuild:

```sh
/Users/dyl/.nvm/versions/node/v22.23.2/bin/node tests/profile-ui/build.mjs
/Users/dyl/.nvm/versions/node/v22.23.2/bin/node tests/profile-ui/run.mjs --ui-build
```

This publishes only `phase2-ui-rendered-build.json`, not the parser-owned
readiness marker. The build uses scratch HOME/TMP/DB paths, rejects `.env`,
and permits external build traffic only through the prepared public-font
proxy. It removes generated `.next` before building, with no in-repo backup.
Types, focused lint, draft units and the identity-validator self-test must pass.
The final browser run still enforces all 128 identities and exact source hashes.

For test-only diagnostics, append `--diagnostic --project=mobile390-light`
to either runner command. Only profile test/config hash changes are permitted;
application sources and the compiled build must still match. Such runs record
`diagnostic:true` and never claim `passed:true` or final-gate acceptance.
Stop the server and rebuild after any application source change.

Never use `send_message_to_thread` in any namespace or wrapper. No nested
agents, real accounts/documents, SMTP, inference, employer actions or cloud
uploads belong in this fixture run.
