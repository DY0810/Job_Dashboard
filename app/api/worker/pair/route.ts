import { workerEndpoint } from '@/lib/applications/worker-http';
export const POST = (request: Request) => workerEndpoint(request, 'pair');
