import { ProfileSaveError } from '@/lib/profile-drafts';
import { EXPECTED_APPLICANT_HEADER } from '@/lib/applications/applicant-precondition';

export type PrivateApi = (path: string, init?: RequestInit) => Promise<unknown>;
export async function privateJson(path: string, init: RequestInit = {}, expectedOwner?: string): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (expectedOwner !== undefined) headers.set(EXPECTED_APPLICANT_HEADER, expectedOwner);
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ProfileSaveError(
      response.status === 401 ? 'Session expired. Unlock Workie, then unlock your draft.' :
        response.status === 403 ? 'Applicant access denied. Check the signed-in account.' :
          response.status === 503 ? 'Private service unavailable. Check configuration and retry.' :
            response.status === 409 ? 'A newer version exists. Review before saving.' :
              typeof body?.error === 'string' ? body.error : 'Request failed. Retry.',
      response.status, body?.current,
    );
  }
  return body;
}
