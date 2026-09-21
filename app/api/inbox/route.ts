import { questionsEndpoint } from '@/lib/applications/questions-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const GET = (request: Request) => questionsEndpoint(request, 'inbox');
