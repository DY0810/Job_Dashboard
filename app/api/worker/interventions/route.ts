import { workerQuestionsEndpoint } from '@/lib/applications/questions-http';
export const POST = (request: Request) => workerQuestionsEndpoint(request, 'poll');
