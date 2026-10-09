import 'server-only';
import { HouseholdAuthError, readHouseholdConfig, resolveHouseholdApplicant } from '@/lib/household-auth';

export type Applicant = { ownerId: string; email: string; name: string };

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

/** One authoritative read of the household session for the endpoint and private guards. */
export async function lookupApplicant(request: Request | Headers): Promise<{ applicant: Applicant; response: Response } | Response> {
  try {
    const config = readHouseholdConfig();
    if (request instanceof Request) {
      const denied = sameOriginMutation(request, config.origin);
      if (denied) return denied;
    }
    return { applicant: await resolveHouseholdApplicant(request, undefined, config), response: privateResponse(new Response(null)) };
  } catch (error) {
    if (error instanceof HouseholdAuthError) return privateJson({ error: error.message }, { status: error.status });
    return applicantUnavailable();
  }
}
