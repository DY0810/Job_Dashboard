import { questionsEndpoint } from '@/lib/applications/questions-http';
export async function POST(request: Request) {
  return questionsEndpoint(request, 'answers');
}
