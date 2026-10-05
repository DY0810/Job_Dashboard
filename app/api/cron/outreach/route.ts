import { getPrivateDb } from '@/lib/private-db';
import { sendDueOutreach } from '@/lib/applications/outreach';
import { cronGate } from '@/lib/write-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Sends the recruiter emails the applicant queued whose Tue–Thu window has come; same gates as /api/cron/refresh. */
export async function GET(request: Request) {
  const denied = cronGate(request);
  if (denied) return denied;
  if (!process.env.VERCEL || process.env.VERCEL_ENV !== 'production') {
    return Response.json({ error: 'scheduler requires the production deployment' }, { status: 503 });
  }
  return Response.json({ sent: await sendDueOutreach(getPrivateDb()) }, { headers: { 'Cache-Control': 'no-store' } });
}
