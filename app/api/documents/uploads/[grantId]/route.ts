import { handleDocumentRequest } from '@/lib/applications/documents-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export async function PUT(request: Request, context: { params: Promise<{ grantId: string }> }) {
  return handleDocumentRequest(request, 'local-upload', (await context.params).grantId);
}
