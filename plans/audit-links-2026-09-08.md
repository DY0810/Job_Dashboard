# Apply-link audit - 2026-09-08

## Scope

- Production target: `https://job-dashboard-one-sigma.vercel.app`
- Rendered views: Design employed, Design freelance, Engineering.
- Coverage limit: 200 rendered rows per view, matching `ROW_CAP` in `lib/query.ts`.
- Read-only: no local or production database writes and no `linkcheck` mutation mode.

## Method

1. Fetch each server-rendered board view and extract only each row's `?job=<id>` and `apply`
   href.
2. Compare the rendered href to `GET /api/postings/<id>` `canonicalUrl`.
3. Check external links through `checkLink` using `createRuntime` with `publicOnly: true`,
   robots support, a per-host 500 ms gap, one retry, and a 15-second timeout.
4. Treat only 404, 410, or a platform-specific gone page as dead. A generic 200 is unknown.
   Robots refusals and 401/403/429 are blocked, not dead.
5. Do not request LinkedIn, Indeed, Glassdoor, ZipRecruiter, or Handshake links.

## Canonical URL trace

- `scripts/connectors/*` produce `sourceUrl` and, where available, a distinct `applyUrl`.
- `lib/dedupe.ts` selects the winning source by source priority and stores a scheme-checked
  `applyUrl` before `sourceUrl` as `postings.canonicalUrl`.
- `app/page.tsx` and `app/drawer.tsx` render that `canonicalUrl` directly as the Apply href.
- `app/api/postings/[id]` returns the same field from `lib/query.ts`.

The production audit compared every rendered Apply href with its matching detail API result;
all 435 row IDs matched their `canonicalUrl`.

## Results

The initial parser supported only the default `/?job=<id>` shape. The board serializes
non-default state before `job`, so the parser now supports both forms and has regression
coverage. This was an audit-script defect, not evidence of missing production rows.

Post-runtime-fix validation on September 8, 2026:

- Design employed: 199 rendered rows; 199 API href matches; 117 live, 1 dead, 33 blocked,
  48 unknown.
- Design freelance: 37 rendered rows; 37 API href matches; 25 live, 0 dead, 4 blocked,
  8 unknown.
- Engineering: 199 rendered rows; 199 API href matches; 116 live, 0 dead, 12 blocked,
  71 unknown.
- Total: 435 rendered rows; 435 API href matches; 258 live, 1 dead, 49 blocked, 127 unknown.

`blocked` means robots or an access response such as 403; `unknown` includes generic 200
responses with no job-page evidence and timeouts. Neither category is a delisting candidate.

Posting `26295` in Design employed is confirmed dead. Its application URL,
`jobs.ashbyhq.com/ashby/07201b7e-a581-46a6-bbd3-432824bd761f/application`, returned a
client shell with `posting:null` and `jobBoard:null`. More importantly, Ashby's official
`posting-api/job-board/ashby` response returned 71 currently listed jobs (`isListed:true`) and
none had that UUID in its ID, job URL, or application URL. This is a valid targeted
`linkcheck --ids=26295` candidate for the cloud writer; this read-only audit did not update
any database.

No displayed link matched a prohibited LinkedIn, Indeed, Glassdoor, ZipRecruiter, or Handshake
host, so none was requested. The post-fix test gate was 64 passing tests across
`lib/runtime.test.ts`, `scripts/linkcheck.test.ts`, and `scripts/audit-links.test.ts`.

## Follow-up

`linkcheck` currently classifies response bodies using the stored pre-redirect URL. Final URL
exposure from the runtime is not required for fail-closed behavior, but would let callers
apply host-specific 200-page fingerprints to the destination that actually served the body.

The one known malformed Greenhouse-style URL observed during this audit was blocked by robots,
not classified dead. No observed redirect produced a false dead verdict, so no new runtime API
is justified for this change; generic or opaque 200 responses remain unknown.

## Pagination and Outreach Audit

`scripts/audit-links.ts` now follows same-origin `rel=next`, visible `Next`, or
`aria-label=next` board links. It is bounded to two pages and 400 rows per view and reports
`partial` with the reason when either cap is reached. It also emits `paginationState`:
`complete`, `partial`, or `next-link-absent`. The last state is intentionally not a claim that
the full corpus was covered. It writes the full JSON report to an explicit `--output` path
outside the repository, or `/tmp/workie-link-audit.json` by default. The current production
deployment has no next link yet, so this behavior is regression-tested against markup rather
than claimed as live pagination coverage.

Read-only outreach audit findings:

- The UI caps queued drafts at `MAX_BATCH` (10), but `sendQueue` appends the current ready form
  draft. A full queue plus a ready form submits 11 messages, which the API schema rejects with
  HTTP 400.
- `stillQueued` retains failed drafts by recipient address only. If two messages in one batch
  share an address and only one fails, both remain queued and the successful duplicate can be
  resent. The send response lacks a per-message identifier, so this cannot be resolved safely
  in the client without a shared contract change.
