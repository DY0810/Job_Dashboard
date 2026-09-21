import { workerQuestionsEndpoint } from '@/lib/applications/questions-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const POST = (request: Request) => workerQuestionsEndpoint(request, 'poll');
