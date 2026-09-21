import 'server-only';
import { z } from 'zod';
import { getAuth, type ApplicantAuth } from '@/lib/auth';

export type Applicant = { ownerId: string; email: string; name: string };
const applicantSession = z.object({
  user: z.object({
    id: z.string().min(1), email: z.email(), name: z.string(), emailVerified: z.boolean(),
  }),
  session: z.object({ userId: z.string().min(1) }),
});

export function privateResponse(response: Response): Response {
  // Clone headers: framework redirects can have an immutable Headers guard.
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', 'private, no-store');
  headers.set('CDN-Cache-Control', 'no-store');
  headers.set('Vercel-CDN-Cache-Control', 'no-store');
  const vary = new Set((headers.get('Vary') ?? '').split(',').map((s) => s.trim()).filter(Boolean));
  vary.add('Cookie');
  vary.add('Origin');
  headers.set('Vary', [...vary].join(', '));
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function privateJson(data: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  // A replacement JSON body no longer has the upstream size or encoding.
  headers.delete('Content-Length');
  headers.delete('Content-Encoding');
  headers.set('Content-Type', 'application/json');
  return privateResponse(Response.json(data, { ...init, headers }));
}

export function applicantUnavailable(headers?: HeadersInit): Response {
  return privateJson({ error: 'Applicant authentication is unavailable.' }, { status: 503, headers });
}

export function sameOriginMutation(request: Request, origin: string): Response | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return null;
  return request.headers.get('origin') === origin && request.headers.get('sec-fetch-site') !== 'cross-site'
    ? null
    : privateJson({ error: 'Same-origin request required.' }, { status: 403 });
}

/** One HTTP-limited, authoritative read for the endpoint and private guards. */
export async function lookupApplicant(
  request: Request | Headers,
  providedAuth?: ApplicantAuth,
): Promise<{ applicant: Applicant; response: Response } | Response> {
  try {
    const auth = providedAuth ?? getAuth();
    if (request instanceof Request) {
      const denied = sameOriginMutation(request, auth.origin);
      if (denied) return denied;
    }
    // v1.7.5 supports these query flags over HTTP. Never recurse through our route.
    const response = privateResponse(await auth.handler(new Request(
      new URL('/api/auth/get-session?disableCookieCache=true&disableRefresh=true', auth.origin),
      { headers: request instanceof Request ? request.headers : request },
    )));
    if (!response.ok) return response.status >= 500 ? applicantUnavailable(response.headers) : response;
    const data: unknown = await response.clone().json().catch(() => undefined);
    if (data === null) return privateJson({ error: 'Sign in required.' }, { status: 401, headers: response.headers });
    const parsed = applicantSession.safeParse(data);
    if (!parsed.success || parsed.data.session.userId !== parsed.data.user.id) {
      return applicantUnavailable(response.headers);
    }
    const { user } = parsed.data;
    if (!user.emailVerified || !auth.isAllowedApplicant(user.email)) {
      return privateJson({ error: 'Applicant access is not permitted.' }, { status: 403, headers: response.headers });
    }
    return { applicant: { ownerId: user.id, email: user.email, name: user.name }, response };
  } catch {
    return applicantUnavailable();
  }
}

/** Every private DAL operation must use this ownerId, never one supplied by the client. */
export async function requireApplicant(request: Request | Headers, providedAuth?: ApplicantAuth): Promise<Applicant | Response> {
  const result = await lookupApplicant(request, providedAuth);
  return result instanceof Response ? result : result.applicant;
}
