import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return browserWorkerEndpoint(request, 'revoke-worker', (await params).id);
}
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return browserWorkerEndpoint(request, 'schedule-worker', (await params).id);
}
