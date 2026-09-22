import 'server-only';
import { z } from 'zod';
import { getAuth, type ApplicantAuth } from '@/lib/auth';
import { applicantUnavailable, lookupApplicant, privateJson } from '@/lib/applicant-access';

const selection = z.strictObject({ ownerId: z.string().min(1).max(256) });
const deviceSessions = z.array(z.object({
  session: z.object({ token: z.string().min(1) }),
  user: z.object({ id: z.string().min(1), email: z.email(), name: z.string(), emailVerified: z.boolean() }),
}));

async function sessions(request: Request, auth: ApplicantAuth) {
  const response = await auth.handler(new Request(
    new URL('/api/auth/multi-session/list-device-sessions', auth.origin),
    { headers: request.headers },
  ));
  if (!response.ok) return null;
  const parsed = deviceSessions.safeParse(await response.json().catch(() => null));
  return parsed.success ? parsed.data : null;
}

export async function listApplicantSessions(request: Request, providedAuth?: ApplicantAuth): Promise<Response> {
  const auth = providedAuth ?? getAuth();
  const current = await lookupApplicant(request, auth);
  if (current instanceof Response) return current;
  const stored = await sessions(request, auth);
  if (!stored) return applicantUnavailable();
  const applicants = new Map<string, { ownerId: string; email: string; name: string; active: boolean }>();
  applicants.set(current.applicant.ownerId, { ...current.applicant, active: true });
  for (const { user } of stored) {
    if (!user.emailVerified || !auth.isAllowedApplicant(user.email)) continue;
    applicants.set(user.id, { ownerId: user.id, email: user.email, name: user.name, active: user.id === current.applicant.ownerId });
  }
  return privateJson({ applicants: [...applicants.values()].sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name)) });
}

export async function selectApplicantSession(request: Request, raw: unknown, providedAuth?: ApplicantAuth): Promise<Response> {
  const auth = providedAuth ?? getAuth();
  const current = await lookupApplicant(request, auth);
  if (current instanceof Response) return current;
  const parsed = selection.safeParse(raw);
  if (!parsed.success) return privateJson({ error: 'Invalid applicant selection.' }, { status: 400 });
  if (parsed.data.ownerId === current.applicant.ownerId) return privateJson(current.applicant);
  const stored = await sessions(request, auth);
  const target = stored?.find(({ user }) => user.id === parsed.data.ownerId && user.emailVerified && auth.isAllowedApplicant(user.email));
  if (!target) return privateJson({ error: 'Applicant profile is not signed in on this device.' }, { status: 404 });
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  const response = await auth.handler(new Request(new URL('/api/auth/multi-session/set-active', auth.origin), {
    method: 'POST', headers, body: JSON.stringify({ sessionToken: target.session.token }),
  }));
  if (!response.ok) return privateJson({ error: 'Could not switch applicant profile.' }, { status: response.status, headers: response.headers });
  const body = z.object({ user: z.object({ id: z.string(), email: z.email(), name: z.string(), emailVerified: z.boolean() }) })
    .safeParse(await response.json().catch(() => null));
  if (!body.success || body.data.user.id !== target.user.id) return applicantUnavailable(response.headers);
  return privateJson({ ownerId: target.user.id, email: target.user.email, name: target.user.name }, { headers: response.headers });
}
