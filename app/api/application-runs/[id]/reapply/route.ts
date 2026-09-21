import { discoveryEndpoint } from '@/lib/applications/discovery-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return discoveryEndpoint(request, 'reapply', (await params).id);
}
