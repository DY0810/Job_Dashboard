import { handleDocumentBlobRequest } from '@/lib/applications/documents-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const POST = (request: Request) => handleDocumentBlobRequest(request);
