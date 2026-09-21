import { workerEndpoint } from '@/lib/applications/worker-http';

export const runtime = 'nodejs';
export const POST = (request: Request) => workerEndpoint(request, 'provider-config');
