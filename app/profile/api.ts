import { ProfileSaveError } from '@/lib/profile-drafts';
import { EXPECTED_APPLICANT_HEADER } from '@/lib/applications/applicant-precondition';

export type PrivateApi = (path: string, init?: RequestInit) => Promise<unknown>;
/** `owner` pins the expected applicant; `timeout` (ms) is per call, and absent means none. */
export type PrivateInit = RequestInit & { owner?: string; timeout?: number };

/** A non-2xx private response: profile copy as the message, plus the server's code and body. */
export class PrivateRequestError extends ProfileSaveError {
  constructor(message: string, status: number, current: unknown, readonly code: string, readonly body: unknown) {
    super(message, status, current as ProfileSaveError['current']);
  }
}

/** Same-origin, uncached JSON. Method, headers and a raw body pass through unchanged. */
export async function privateJson(path: string, { owner, timeout, ...init }: PrivateInit = {}): Promise<unknown> {
  const headers = new Headers(init.headers);
  if (init.body && typeof init.body === 'string' && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  if (owner) headers.set(EXPECTED_APPLICANT_HEADER, owner);
  const signal = init.signal ?? undefined;
  const limit = timeout === undefined ? undefined : AbortSignal.timeout(timeout);
  const response = await fetch(path, { ...init, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    headers, signal: signal && limit ? AbortSignal.any([signal, limit]) : signal ?? limit });
  const body = await response.json().catch(() => null);
  // An abort during the body read must not surface as a parse failure of a null body.
  signal?.throwIfAborted();
  if (!response.ok) {
    throw new PrivateRequestError(
      response.status === 401 ? 'Session expired. Unlock Workie, then unlock your draft.' :
        response.status === 403 ? 'Applicant access denied. Check the signed-in account.' :
          response.status === 503 ? 'Private service unavailable. Check configuration and retry.' :
            response.status === 409 ? 'A newer version exists. Review before saving.' :
              typeof body?.error === 'string' ? body.error : 'Request failed. Retry.',
      response.status, body?.current, typeof body?.code === 'string' ? body.code : '', body,
    );
  }
  return body;
}
