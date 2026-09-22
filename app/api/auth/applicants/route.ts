import { listApplicantSessions, selectApplicantSession } from '@/lib/applicant-sessions';
import { privateJson } from '@/lib/applicant-access';
import { PrivateInputError, readPrivateJson } from '@/lib/applications/private-http';
import { z } from 'zod';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = (request: Request) => listApplicantSessions(request);

export async function POST(request: Request) {
  try {
    return await selectApplicantSession(request, await readPrivateJson(request, z.unknown()));
  } catch (error) {
    return error instanceof PrivateInputError
      ? privateJson({ error: error.message }, { status: error.status })
      : privateJson({ error: 'Could not switch applicant profile.' }, { status: 503 });
  }
}
