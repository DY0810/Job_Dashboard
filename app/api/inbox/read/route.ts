import { questionsEndpoint } from '@/lib/applications/questions-http';
export const POST = (request: Request) => questionsEndpoint(request, 'read');
