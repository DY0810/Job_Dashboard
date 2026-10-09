import { questionsEndpoint } from '@/lib/applications/questions-http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return questionsEndpoint(request, 'answer', (await params).id);
}
