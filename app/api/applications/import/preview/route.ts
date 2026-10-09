import { discoveryEndpoint } from '@/lib/applications/discovery-http';
export const POST = (request: Request) => discoveryEndpoint(request, 'preview');
