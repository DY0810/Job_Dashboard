import { getPrivateDb } from '@/lib/private-db';
import { PolicySaveSchema, PolicyCommandSchema } from '@/lib/applications/policy';
import { getPolicy, mutatePolicy } from '@/lib/applications/stores';
import { privateEndpoint, readPrivateJson } from '@/lib/applications/private-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return privateEndpoint(request, (ownerId) => getPolicy(getPrivateDb(), ownerId));
}
export async function PATCH(request: Request) {
  return privateEndpoint(request, async (ownerId) =>
    mutatePolicy(getPrivateDb(), ownerId, await readPrivateJson(request, PolicySaveSchema)));
}
export async function POST(request: Request) {
  return privateEndpoint(request, async (ownerId) =>
    mutatePolicy(getPrivateDb(), ownerId, await readPrivateJson(request, PolicyCommandSchema)));
}
