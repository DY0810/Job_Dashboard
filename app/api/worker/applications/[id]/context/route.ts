import { workerEndpoint } from '@/lib/applications/worker-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  workerEndpoint(request, 'context', (await context.params).id);
