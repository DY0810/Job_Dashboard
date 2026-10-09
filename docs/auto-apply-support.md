# Auto Apply Support Matrix

Status is evidence-scoped. A fixture result proves the adapter contract against
the controlled form only; it does not authorize an employer integration or prove
that a live tenant uses the same fields.

| ATS family | Adapter | Fixture flow | Live form read | Live submit receipt | Current limits |
| --- | --- | --- | --- | --- | --- |
| Greenhouse | `greenhouse` | PASS: synthetic fill, upload, submit, exact-role receipt | Not performed | Not performed | Field set is tenant-specific; employer API credentials are not used. |

Ashby, Lever, Jobvite, Workday, Oracle Candidate Experience and iCIMS have no
adapter: their fixture-only stubs were removed in October 2026, and an
application on any of them ends at `blocked_unsupported`/`adapter_unavailable`
before screening.

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
values; no model chooses the action. The worker cannot supply unconfirmed
values, upload an unapproved file, create an account, bypass login/CAPTCHA/MFA, or authorize submission.
Unknown required fields become private interventions. A missing or mismatched
receipt is `submission_unknown`, never a successful application.
