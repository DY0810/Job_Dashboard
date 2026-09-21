import { questionsEndpoint } from '@/lib/applications/questions-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return questionsEndpoint(request, 'question', (await params).id);
}
