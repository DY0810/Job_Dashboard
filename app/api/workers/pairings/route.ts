import { browserWorkerEndpoint } from '@/lib/applications/worker-http';
export const POST = (request: Request) => browserWorkerEndpoint(request, 'create-pairing');
