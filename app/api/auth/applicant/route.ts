import { lookupApplicant, privateJson } from '@/lib/applicant-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const result = await lookupApplicant(request);
  return result instanceof Response
    ? result
    : privateJson(result.applicant, { status: result.response.status, headers: result.response.headers });
}
