# Auto Apply Support Matrix

Status is evidence-scoped. A fixture result proves the adapter contract against
the controlled form only; it does not authorize an employer integration or prove
that a live tenant uses the same fields.

| ATS family | Adapter | Fixture flow | Live form read | Live submit receipt | Current limits |
| --- | --- | --- | --- | --- | --- |
| Greenhouse | `greenhouse` | PASS: synthetic fill, upload, submit, exact-role receipt | Not performed | Not performed | Field set is tenant-specific; employer API credentials are not used. |
| Ashby | `ashby` | PASS: synthetic fill, upload, submit, exact-role receipt | Not performed | Not performed | Public posting access does not authorize application API access. |
| Lever | `lever` | PASS: synthetic fill, upload, submit, exact-role receipt | Not performed | Not performed | Tenant custom fields and employer-authorized API paths require separate qualification. |
| Jobvite | `jobvite` | PASS: synthetic ISO date, fill, upload, submit, exact-role receipt | Not performed | Not performed | Hosted/iframe variations and custom fields may block the run. |
| Workday | `workday` | PASS: synthetic month/year selects, fill, upload, submit, exact-role receipt | Not performed | Not performed | Segmented calendars, conditional pages, frames and authenticated sessions need tenant qualification. |
| Oracle Candidate Experience | `oracle` | PASS: synthetic in-progress degree and prior-employer reconciliation fields, fill, upload, submit, exact-role receipt | Not performed | Not performed | Resume-parser reconciliation and tenant-specific consent fields are not generalized. |
| iCIMS | `icims` | PASS: synthetic fill, upload, submit, exact-role receipt; new-account gate blocked | Not performed | Not performed | Existing-session-only baseline; account creation is never inferred or enabled by hostname. |

## Evidence Levels

- **Documented:** a vendor contract or public form shape was read; this is not
  an implementation or permission grant.
- **Fixture-tested:** the adapter passed a local controlled form with synthetic
  values and a role-bound receipt. No applicant or employer data crossed the
  fixture boundary.
- **Live-read-tested:** an owner-authorized browser inspected one exact tenant
  and version. This repository currently has no live-read records.
- **Live-submit-verified:** an owner-authorized submission produced an exact
  role/tenant/requisition receipt. This repository currently has no live-submit
  records.

## Safe Boundaries

The worker only uses observed accessible controls and deterministic confirmed
values. Jev may select an observed action, but it cannot supply values, upload a
file, create an account, bypass login/CAPTCHA/MFA, or authorize submission.
Unknown required fields become private interventions. A missing or mismatched
receipt is `submission_unknown`, never a successful application.
