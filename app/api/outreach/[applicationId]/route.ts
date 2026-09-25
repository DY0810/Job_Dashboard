import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ applicationId: string }> }) {
  return browserWorkerEndpoint(request, 'send-outreach', (await params).applicationId);
}
