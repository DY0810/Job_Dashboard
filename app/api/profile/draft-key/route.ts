import { getDraftKey } from '@/lib/applications/draft-key';
import { privateEndpoint } from '@/lib/applications/private-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return privateEndpoint(request, async (ownerId) => getDraftKey(ownerId));
}
