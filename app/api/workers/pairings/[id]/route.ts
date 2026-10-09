import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return browserWorkerEndpoint(request, 'revoke-pairing', (await params).id);
}
