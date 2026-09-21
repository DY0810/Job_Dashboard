import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string; applicationId: string }> }) {
  const { id, applicationId } = await params;
  return browserWorkerEndpoint(request, 'command-application', id, applicationId);
}
