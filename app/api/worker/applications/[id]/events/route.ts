import { workerEndpoint } from '@/lib/applications/worker-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workerEndpoint(request, 'event', (await params).id);
}
