import { handleDocumentRequest } from '@/lib/applications/documents-http';

export const maxDuration = 30;
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handleDocumentRequest(request, 'validate', (await context.params).id);
}
