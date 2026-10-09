import { questionsEndpoint } from '@/lib/applications/questions-http';
export const dynamic = 'force-dynamic';
export const GET = (request: Request) => questionsEndpoint(request, 'inbox');
