import { cronGate } from '@/lib/write-gate';
import { POST } from '../../refresh/route';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

/** Wake the existing cloud writer; never run ingestion inside a Vercel function. */
export async function GET(request: Request) {
  const denied = cronGate(request);
  if (denied) return denied;
  if (!process.env.VERCEL || process.env.VERCEL_ENV !== 'production') {
    return Response.json({ error: 'scheduler requires the production deployment' }, { status: 503 });
  }
  if (!process.env.WORKIE_GH_TOKEN?.trim()) {
    return Response.json({ error: 'GitHub dispatch is not configured' }, { status: 503 });
  }

  const url = new URL(request.url);
  url.searchParams.set('by', 'scheduler');
  const response = await POST(new Request(url, { method: 'POST', headers: request.headers }));
  if (response.status !== 202) return response;
  const result = await response.json();
  return Response.json(result, {
    status: result.dispatch === 'failed' ? 502 : 202,
    headers: { 'Cache-Control': 'no-store' },
  });
}
