import { workerQuestionsEndpoint } from '@/lib/applications/questions-http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return workerQuestionsEndpoint(request, 'batch', (await params).id);
}
