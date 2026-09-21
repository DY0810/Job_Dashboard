import { getPrivateDb } from '@/lib/private-db';
import { ProfileSaveSchema } from '@/lib/applications/profile';
import { getProfile, saveProfile } from '@/lib/applications/stores';
import { privateEndpoint, readPrivateJson } from '@/lib/applications/private-http';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET(request: Request) {
  return privateEndpoint(request, (ownerId) => getProfile(getPrivateDb(), ownerId));
}
export async function PATCH(request: Request) {
  return privateEndpoint(request, async (ownerId) =>
    saveProfile(getPrivateDb(), ownerId, await readPrivateJson(request, ProfileSaveSchema)));
}
