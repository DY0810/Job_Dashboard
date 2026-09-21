import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return browserWorkerEndpoint(request, 'revoke-worker', (await params).id);
}
