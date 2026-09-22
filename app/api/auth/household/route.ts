import { z } from 'zod';

import { privateJson, sameOriginMutation } from '@/lib/applicant-access';
import {
  clearHouseholdSessionCookie,
  HouseholdAuthError,
  readHouseholdConfig,
  resolveHouseholdApplicant,
  unlockHousehold,
} from '@/lib/household-auth';
import { PrivateInputError, readPrivateJson } from '@/lib/applications/private-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const unlock = z.strictObject({ passcode: z.string().min(1).max(64), profile: z.enum(['dy', 'may']) });

export async function GET(request: Request) {
  try { return privateJson(await resolveHouseholdApplicant(request)); }
  catch (error) {
    return error instanceof HouseholdAuthError
      ? privateJson({ error: error.message }, { status: error.status })
      : privateJson({ error: 'Household access is unavailable.' }, { status: 503 });
  }
}

export async function POST(request: Request) {
  try {
    const config = readHouseholdConfig();
    const denied = sameOriginMutation(request, config.origin);
    if (denied) return denied;
    const input = await readPrivateJson(request, unlock);
    const result = await unlockHousehold(request, input.passcode, input.profile);
    return privateJson(result.applicant, { headers: { 'Set-Cookie': result.cookie } });
  } catch (error) {
    if (error instanceof HouseholdAuthError || error instanceof PrivateInputError) {
      return privateJson({ error: error.message }, { status: error.status });
    }
    return privateJson({ error: 'Household access is unavailable.' }, { status: 503 });
  }
}

export async function DELETE(request: Request) {
  try {
    const config = readHouseholdConfig();
    const denied = sameOriginMutation(request, config.origin);
    if (denied) return denied;
    return privateJson({ signedOut: true }, { headers: { 'Set-Cookie': clearHouseholdSessionCookie(config) } });
  } catch {
    return privateJson({ error: 'Household access is unavailable.' }, { status: 503 });
  }
}
