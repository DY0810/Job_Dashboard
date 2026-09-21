import { workerDocumentEndpoint } from '@/lib/applications/worker-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = async (request: Request, context: { params: Promise<{ id: string; documentId: string }> }) => {
  const params = await context.params;
  return workerDocumentEndpoint(request, params.id, params.documentId);
};
