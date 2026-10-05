import { getPrivateDb } from '@/lib/private-db';
import { sendDueOutreach } from '@/lib/applications/outreach';
import { cronGate } from '@/lib/write-gate';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Sends the recruiter emails whose Tue–Thu window has opened; same `Bearer $CRON_SECRET` gate as /api/cron/refresh. */
export async function GET(request: Request) {
  const denied = cronGate(request);
  if (denied) return denied;
  return Response.json({ sent: await sendDueOutreach(getPrivateDb(), { scheduled: true }) }, { headers: { 'Cache-Control': 'no-store' } });
}
