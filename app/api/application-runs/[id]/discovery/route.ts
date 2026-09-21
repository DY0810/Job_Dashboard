import { discoveryEndpoint } from '@/lib/applications/discovery-http';
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return discoveryEndpoint(request, 'status', (await params).id);
}
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  return discoveryEndpoint(request, 'abandon', (await params).id);
}
