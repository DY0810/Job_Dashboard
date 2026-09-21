import { workerEndpoint } from '@/lib/applications/worker-http';

export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  workerEndpoint(request, 'receipt', (await context.params).id);
