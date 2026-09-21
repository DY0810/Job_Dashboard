import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) => browserWorkerEndpoint(request, 'list-runs');
export const POST = (request: Request) => browserWorkerEndpoint(request, 'create-run');
