import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return browserWorkerEndpoint(request, 'command-run', (await params).id);
}
