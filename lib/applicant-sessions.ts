import 'server-only';
import { z } from 'zod';
import { applicantUnavailable, privateJson } from '@/lib/applicant-access';
import { HouseholdAuthError, listHouseholdApplicants, switchHouseholdApplicant } from '@/lib/household-auth';

const selection = z.strictObject({ ownerId: z.string().min(1).max(256) });

function failure(error: unknown) {
  return error instanceof HouseholdAuthError
    ? privateJson({ error: error.message }, { status: error.status })
    : applicantUnavailable();
}

export async function listApplicantSessions(request: Request): Promise<Response> {
  try { return privateJson({ applicants: await listHouseholdApplicants(request) }); }
  catch (error) { return failure(error); }
}

export async function selectApplicantSession(request: Request, raw: unknown): Promise<Response> {
  const parsed = selection.safeParse(raw);
  if (!parsed.success) return privateJson({ error: 'Invalid applicant selection.' }, { status: 400 });
  try {
    const result = await switchHouseholdApplicant(request, parsed.data.ownerId);
    return privateJson(result.applicant, { headers: { 'Set-Cookie': result.cookie } });
  } catch (error) { return failure(error); }
}
