import { workerEndpoint } from '@/lib/applications/worker-http';

// Recruiter lookup and SMTP send run inside this request.
export const maxDuration = 60;
export const POST = async (request: Request, context: { params: Promise<{ id: string }> }) =>
  workerEndpoint(request, 'outreach', (await context.params).id);
