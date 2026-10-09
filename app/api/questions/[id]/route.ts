import { questionsEndpoint } from '@/lib/applications/questions-http';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return questionsEndpoint(request, 'question', (await params).id);
}
