export const EXPECTED_APPLICANT_HEADER = 'x-workie-applicant';

export class ApplicantPreconditionError extends Error {
  readonly status = 403;
  constructor() { super('Applicant session changed. Unlock the current account.'); }
}

// A precondition only: ownerId must come from the authenticated session.
export function assertExpectedApplicant(request: Request, ownerId: string): void {
  const expected = request.headers.get(EXPECTED_APPLICANT_HEADER);
  if ((expected !== null || !['GET', 'HEAD'].includes(request.method)) && expected !== ownerId) {
    throw new ApplicantPreconditionError();
  }
}
