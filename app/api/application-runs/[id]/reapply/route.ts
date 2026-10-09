import { discoveryEndpoint } from '@/lib/applications/discovery-http';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return discoveryEndpoint(request, 'reapply', (await params).id);
}
