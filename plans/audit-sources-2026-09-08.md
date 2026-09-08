# Collector Source Audit - 2026-09-08

Scope: `scripts/connectors/`, `scripts/companies.json`, and source reporting only. No database
ingest, workflow, runtime, secrets, or robot-policy override was changed.

## Evidence

- GitHub Actions run `34190831847` (2026-09-08) fetched 21,050 rows: 21 connectors succeeded,
  SmartRecruiters failed because all 10 registered boards were refused by `robots.txt`, and five
  sources skipped. Careerjet and Jooble skipped because their keys were absent; Remotive, Adzuna,
  and USAJobs remain blocked by their recorded robot rules.
- A bounded live read through `createRuntime()` before this change returned Himalayas 100 of
  105,309 reported rows, Jobicy 60 of 60, and Muse 97 rows. Muse reported 2 Internship pages,
  0 Entry Level pages, and 20 Mid Level pages; page 19 was dated 2026-06-26, 74 days before
  2026-09-08 and outside the 60-day window.
- Direct inspection of the provider OpenAPI document confirmed browse cursor pagination and a
  filtered `/jobs/api/search` endpoint. The shared runtime refused that search path under the
  host's current `robots.txt`, so no filtered search call was made or enabled.
- Direct ATS probes added 2,593 current employer-board rows: Anduril 2,212, Cursor 124, and
  xAI 257. Their 60-day counts were 1,042, 47, and 140 respectively.
- Live Muse checks confirmed the dashboard's Design seniority exemption, but also found that
  the API's `Management` level request returned a `Mid Level` result. Design Senior and
  Management report 89 and 110 pages, while Science and Engineering reports 11 Internship,
  4 Entry Level, and 149 Mid Level pages. Those broad source scopes are not safe to represent
  with the synchronous connector's fixed page cap.
- Jobicy's live industry taxonomy includes `engineering`; its 200-row Engineering response is
  at the provider cap. SimplifyJobs' canonical `New-Grad-Positions` repository is on `dev`;
  the existing HTML-table parser returned 420 rows from its current README.
- Registry repair on September 8, 2026: Marqeta's official job detail linked to Ashby board
  `marqeta-inc` (42 listed jobs), and Superhuman's official careers embed resolved to Ashby
  board `superhuman platform inc` (65 listed jobs). Intercom's official Fin careers surface
  still points to a Greenhouse-hosted job path whose current page and public API both return
  404, so the entry remains intact pending a verifiable replacement.
- Cursor's official careers index exposed a UUID-to-slug map for all 124 live Ashby jobs. The
  audited `723239cc-f90f-409d-86ec-3b02df603239` Ashby application URL rendered Page not found,
  while Cursor's matching employer page served an embedded application form. Cursor now maps
  matching publisher IDs to those employer-published career URLs; unmatched IDs retain their
  normal Ashby URLs rather than being discarded.

## Changes

- Muse now walks full `Design and UX` and `Science and Engineering` category scopes in
  checkpointed bounded chunks. The earlier fixed Design subset returned 431 mapped postings
  rather than 97 before its page fix; all checkpoint chunks are now marked partial so they
  cannot ghost-delist postings from other chunks.
- Himalayas now uses the provider's opaque browse cursor rather than deprecated offsets and
  follows the provider's daily cache cadence. Its bounded chunks advance a persisted full
  catalogue crawl across cloud runs and remain ghost-degraded until separate whole-scan
  reconciliation is implemented.
- Jobicy's 60-row Design corpus fits below its now-200-row request cap. A second
  `jobicy-engineering` connector adds the live Engineering industry window. The Engineering
  response reaches that provider cap and is marked partial.
- Added `simplify-new-grads`, reading the verified `SimplifyJobs/New-Grad-Positions` README
  through the same tested table contract as the internships source.
- Added direct, robot-permitted employer boards for Anduril, Cursor, and xAI after live
  structured API probes. Their APIs returned the counts recorded above without pagination
  metadata, so the configured Greenhouse/Ashby connectors read their complete returned boards.
- Amazon reports 10,000 hits and now reads that full accessible unfiltered window. It remains
  partial at the provider ceiling. Workday already reports its 100-row-per-company page cap;
  SmartRecruiters is robot-refused. Braintrust returned 8 of 8 with no next page, Working
  Nomads returned 47 rows, and RemoteOK returned 100 jobs plus its non-job metadata row.
- Amazon's official UI exposes `business_category[]=amazon-web-services`; its observed
  `search.json` response mapped this to `businessCategory=aws` and returned 8,027 hits with no
  geography filter. The connector now adds that finite AWS partition after the 10,000-hit
  unfiltered window and deduplicates by native publisher ID or job URL. This extends coverage
  but does not prove a complete Amazon category taxonomy, so the unfiltered cap remains explicit.

## Checkpointed Catch-Up

Himalayas now stores a versioned source checkpoint containing its opaque cursor, provider
`updatedAt`, reported total, cumulative scanned count, and completion state. Each cloud run reads
at most 100 cursor pages by default, or a validated `WORKIE_CATCH_UP_PAGES` override from 1 to
1,000. It stages the next state with `pending: true` and resumes from that cursor next cycle. A
final page stages `pending: false`; the next normal due cycle begins a new resumable sweep rather
than freezing the source at its first pages. An HTTP 400 cursor rejection or a repeated cursor
resets safely to the head. The crawl never stops on `posted_at`, because `effectiveAt` floors a
newly discovered, still-listed requisition at `firstSeenRun`.

The integrated Muse importer uses a version-2 company-directory checkpoint and five categories:
Design and UX, Software Engineering, Data and Analytics, Computer and IT, and Science and
Engineering. Oversized company/category partitions split by the four supported seniority levels.
Unexpected empty pages before the advertised end do not advance the checkpoint. Production
registration and a live registered sweep remain unverified because `MUSE_API_KEY` is absent.
Both resumable connectors stay ghost-degraded for every chunk, including the final chunk,
because whole-scan reconciliation is intentionally out of scope.

## Hard Limits

This improves completeness for configured, accessible sources; it cannot guarantee all jobs
globally. Sources without a public, robot-permitted structured interface remain unavailable,
keyed sources require their configured credentials, and the explicit exclusions remain
LinkedIn, Indeed, Glassdoor, ZipRecruiter, and Handshake. All live reads in this audit used the
shared runtime's robots, timeout, retry, and per-host rate-limit policy.

## Integration

The final integration adds publisher IDs from native ATS fields, indexed source
lookups, and repair of historically merged requisitions. The registry now has
245 entries. Workday pagination expands from 100 rows per company to the complete
reported listing up to 500 pages, retaining successfully fetched pages on a later
failure. Amazon expands from 1,500 to its 10,000-result search window and remains
explicitly partial at that observed ceiling.

Himalayas and Muse now use the local `connector_checkpoints` contract: cursor
advancement commits after postings, pending scans bypass the completed-scan
cadence, and the cloud `catch_up` workflow advances only pending catalogs between
enrichment and mirror steps. Cloud run `34257909517` completed the Himalayas traversal and
reported no enabled pending imports. The later targeted run `34269480932` verified 2,498
Workday records and the full 10,000-result Amazon window. Registry repairs and the AWS
supplement still require their own post-change cloud verification.
