import { handleDocumentRequest } from '@/lib/applications/documents-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDocumentRequest(request, 'download', (await context.params).id);
}
