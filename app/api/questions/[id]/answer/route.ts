import { questionsEndpoint } from '@/lib/applications/questions-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return questionsEndpoint(request, 'answer', (await params).id);
}
