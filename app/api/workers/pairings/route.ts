import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = (request: Request) => browserWorkerEndpoint(request, 'create-pairing');
