# Apply-link audit - 2026-09-08

## Scope

- Production target: `https://job-dashboard-one-sigma.vercel.app`
- Rendered views: Design employed, Design freelance, Engineering.
- Historical baseline: the pre-pagination board rendered up to 200 rows per view, matching
  `ROW_CAP` in `lib/query.ts`.
- Expanded follow-up: page traversal is controlled by `--max-pages` and the total scheduling
  budget; it is not a fixed 200-row evidence ceiling.
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
all 435 row IDs matched their `canonicalUrl`. This was a bounded legacy-parser pass, not a
complete census: the old parser missed streamed Apply cells that were separated from their
posting-ID row.

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

The earlier dead classification for posting `26295` is withdrawn. A later September 8
check of the official 71-job Ashby board found this exact UUID with `isListed:true`, and
its application page served JobPosting metadata. Cursor posting `43661` provided a
concurrent counterexample: its official API listed the role while its HTML was the
generic `Jobs` shell. An empty Ashby shell alone is not evidence of closure.

`linkcheck` now consults the official board for an ambiguous Ashby shell, caching one
response per board per runtime. A matching listed job prevents a closure inference,
but does not prove its application URL works. A real-browser check of Cursor `43661`
displayed "Page not found" despite `isListed:true`. It remains unverified pending
a usable employer application URL. Absence from a valid,
nonempty board supports closure. Missing, empty or malformed API data remains
unverifiable. The fresh page check confirmed `26295` as live, and `24333`
as absent from Airwallex's official board.

No displayed link matched a prohibited LinkedIn, Indeed, Glassdoor, ZipRecruiter, or Handshake
host, so none was requested. The post-fix test gate was 64 passing tests across
`lib/runtime.test.ts`, `scripts/linkcheck.test.ts`, and `scripts/audit-links.test.ts`.

## Follow-up

The expanded pass on `ca21fe8` paired 3,447 rendered links across 18 pages. It is not
a complete census: one streamed anchor was still outside its original cell,
Engineering pagination overlapped during publication, and local DNS failures made
2,171 detail-API checks unavailable. Its six provisional dead results include the
two Ashby false positives discussed above. No database changes came from that pass.

The parser now reads marked anchors independently of their original cells. After
an origin returns 403 or 429, later URLs on that origin are recorded as unrequested
and blocked, not falsely described as having returned that status. This avoids
repeated requests to a provider that has already refused the audit.

`linkcheck` currently classifies response bodies using the stored pre-redirect URL. Final URL
exposure from the runtime is not required for fail-closed behavior, but would let callers
apply host-specific 200-page fingerprints to the destination that actually served the body.

The one known malformed Greenhouse-style URL observed during this audit was blocked by robots,
not classified dead. No observed redirect produced a false dead verdict, so no new runtime API
is justified for this change; generic or opaque 200 responses remain unknown.

## Pagination and Outreach Audit

`scripts/audit-links.ts` follows same-origin `rel=next`, visible `Next`, or `aria-label=next`
board links. It defaults to at most 20 pages per view and a 20-minute total budget; callers
may supply validated `--max-pages=<1..100>` and
`--time-budget-seconds=<1..7200>` overrides. The time budget stops scheduling new page/link
work; already-started checks retain their request-level timeouts and are allowed to finish so
their verdicts are not discarded. A page cap, budget exhaustion, fetch error, pagination loop,
or duplicate posting ID produces an explicit partial result while preserving rows already
discovered.

The report preserves raw rendered rows, reports duplicate ID values before any deduplication,
and stores every per-link API/link verdict in the ignored JSON output. Duplicate IDs force
partial/incomplete coverage because offset pages may have overlapped while the source changed.
Discovery also counts `td[data-field="apply"]` cells and pairs marked Apply anchors via
`data-posting-id`; any unpaired cell forces partial coverage rather than claiming a complete
199-of-200 page.
Network work is deduplicated only by the exact `id + URL` pair, so repeated rendered rows retain
evidence without repeatedly checking the same destination. It emits `paginationState`:
`complete`, `partial`, or `next-link-absent`; the last state is intentionally not a claim that
the full corpus was covered. It writes to an explicit `--output` path outside the repository,
or `/tmp/workie-link-audit.json` by default.

Read-only outreach audit findings:

- The UI caps queued drafts at `MAX_BATCH` (10), but `sendQueue` appends the current ready form
  draft. A full queue plus a ready form submits 11 messages, which the API schema rejects with
  HTTP 400.
- `stillQueued` retains failed drafts by recipient address only. If two messages in one batch
  share an address and only one fails, both remain queued and the successful duplicate can be
  resent. The send response lacks a per-message identifier, so this cannot be resolved safely
  in the client without a shared contract change.
