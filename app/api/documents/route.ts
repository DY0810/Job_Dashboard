import { handleDocumentRequest } from '@/lib/applications/documents-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;
export const GET = (request: Request) => handleDocumentRequest(request, 'list');
export const POST = (request: Request) => handleDocumentRequest(request, 'create');
