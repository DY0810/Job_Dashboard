import { discoveryEndpoint } from '@/lib/applications/discovery-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = (request: Request) => discoveryEndpoint(request, 'preview');
