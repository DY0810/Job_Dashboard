import 'server-only';
import { getAuth, type ApplicantAuth } from '@/lib/auth';
import { applicantUnavailable, lookupApplicant, privateJson, privateResponse, sameOriginMutation } from '@/lib/applicant-access';

const publicPaths = new Set([
  '/sign-up/email', '/sign-in/email', '/sign-out', '/verify-email',
  '/send-verification-email', '/request-password-reset', '/reset-password',
]);
const privatePaths = new Set(['/get-session', '/list-sessions', '/revoke-session', '/revoke-sessions']);
const genericPaths = new Set(['/sign-up/email', '/send-verification-email', '/request-password-reset']);
const MAX_AUTH_BODY = 16_384;

export async function handleAuthRequest(request: Request, resolveAuth: () => ApplicantAuth = getAuth): Promise<Response> {
  try {
    const auth = resolveAuth();
    const denied = sameOriginMutation(request, auth.origin);
    if (denied) return denied;
    const path = new URL(request.url).pathname.slice('/api/auth'.length);
    if (!publicPaths.has(path) && !privatePaths.has(path)) {
      return privateJson({ error: 'Not found.' }, { status: 404 });
    }
    if (privatePaths.has(path)) {
      const result = await lookupApplicant(request, auth);
      if (result instanceof Response) return result;
      if (path === '/get-session' && request.method === 'GET') return result.response;
    }
    if (request.method === 'POST') {
      if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
        return privateJson({ error: 'JSON required.' }, { status: 415 });
      }
      const reader = request.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_AUTH_BODY) {
            await reader.cancel();
            return privateJson({ error: 'Request too large.' }, { status: 413 });
          }
          chunks.push(value);
        }
      }
      request = new Request(request.url, {
        method: request.method, headers: request.headers, body: Buffer.concat(chunks),
      });
    }
    // All browser actions go through the HTTP handler: auth.api bypasses HTTP rate limits.
    const response = await auth.handler(request);
    if (response.status >= 500) return applicantUnavailable(response.headers);
    if (response.ok && genericPaths.has(path)) {
      return privateJson(
        { status: true, message: 'If this address is eligible, check your email to continue.' },
        { status: response.status, statusText: response.statusText, headers: response.headers },
      );
    }
    return privateResponse(response);
  } catch {
    return applicantUnavailable();
  }
}
