import { workerEndpoint } from '@/lib/applications/worker-http';

export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  workerEndpoint(request, 'context', (await context.params).id);
