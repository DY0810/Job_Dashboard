import { workerEndpoint } from '@/lib/applications/worker-http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workerEndpoint(request, 'event', (await params).id);
}
