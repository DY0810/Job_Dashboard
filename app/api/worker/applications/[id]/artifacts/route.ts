import { workerEndpoint } from '@/lib/applications/worker-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  workerEndpoint(request, 'artifact-intent', (await context.params).id);
