import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { toNextJsHandler } from 'better-auth/next-js';
import { createAuthClient } from 'better-auth/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as authModule from '@/lib/auth';
import { createAuth, readAuthConfig, type AuthConfig } from '@/lib/auth';
import { handleAuthRequest } from '@/lib/auth-http';
import { type AuthMail } from '@/lib/auth-mail';
import { privateJson, privateResponse, requireApplicant } from '@/lib/applicant-access';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '@/lib/private-db';
import { account, rateLimit, session, user, verification } from '@/lib/private-db/schema';

const baseURL = 'https://workie.example.test';
vi.mock('server-only', () => ({}));
const emailA = 'alice@example.test';
const emailB = 'bob@example.test';
const password = 'synthetic-password-only-123';
const generic = { status: true, message: 'If this address is eligible, check your email to continue.' };

let db: PrivateDb;
let dir: string;
let auth: ReturnType<typeof createAuth>;
let mail: AuthMail[];
let tasks: (() => Promise<void>)[];
let allowedEmails: string[];
let config: AuthConfig;

function request(path: string, body?: unknown, cookie = '', origin: string | null = baseURL): Request {
  return new Request(new URL(path.startsWith('/api/') ? path : `/api/auth${path}`, baseURL), {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(origin === null ? {} : { origin }),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function handle(path: string, body?: unknown, cookie = '', origin: string | null = baseURL) {
  const handlers = toNextJsHandler((req) => handleAuthRequest(req, () => auth));
  const req = request(path, body, cookie, origin);
  return body === undefined ? handlers.GET(req) : handlers.POST(req);
}

async function drain() {
  while (tasks.length) await tasks.shift()!();
}

async function enroll(email: string) {
  const response = await handle('/sign-up/email', { email, password, name: 'Synthetic applicant', callbackURL: '/sign-in?verified=1' });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(generic);
  await drain();
  const message = mail.findLast((entry) => entry.kind === 'verification' && entry.to === email)!;
  expect(message).toBeDefined();
  const verified = await handleAuthRequest(new Request(message.url), () => auth);
  expect(verified.status).toBe(302);
  const [row] = await db.select().from(user).where(eq(user.email, email));
  expect(row.emailVerified).toBe(true);
  return row;
}

async function login(email: string) {
  const response = await handle('/sign-in/email', { email, password });
  expect(response.status).toBe(200);
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.find((value) => value.startsWith('__Secure-workie.session_token='))!;
  expect(cookie).toBeDefined();
  expect(cookie).toContain('HttpOnly');
  expect(cookie).toContain('Secure');
  expect(cookie).toMatch(/SameSite=Lax/i);
  expect(cookies.some((value) => value.includes('session_data'))).toBe(false);
  const data = await response.json();
  return { cookie: cookie.split(';')[0], token: data.token as string };
}

async function addSessions(ownerId: string, count: number) {
  await db.insert(session).values(Array.from({ length: count }, (_, index) => ({
    id: `synthetic-${ownerId}-${index}`,
    token: `synthetic-token-${ownerId}-${index}`,
    userId: ownerId,
    expiresAt: new Date(Date.now() + 86_400_000),
    updatedAt: new Date(),
  })));
}

beforeEach(async () => {
  vi.stubEnv('VERCEL', '');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden in auth tests.'); }));
  const root = join(process.cwd(), 'logs/auto-apply-gate');
  mkdirSync(root, { recursive: true });
  dir = mkdtempSync(join(root, 'auth-'));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` }, { corpusPath: join(dir, 'corpus.db') });
  await migratePrivateDb(db);
  mail = [];
  tasks = [];
  allowedEmails = [emailA, emailB];
  config = { baseURL, secret: randomBytes(32).toString('hex'), mailFrom: 'auth@example.test', allowedEmails };
  auth = createAuth(config, db, {
    sendMail: async (message) => { mail.push(message); },
    scheduleMail: (task) => { tasks.push(task); },
    allowedEmails: () => allowedEmails,
  });
});

afterEach(() => {
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('real Better Auth HTTP factory with migrated async libSQL and synthetic mail', () => {
  it('requires verification, hashes passwords, and gives identical new/duplicate/out-of-scope signup responses', async () => {
    const payload = { email: emailA, password, name: 'Alice', emailVerified: true, ownerId: 'forged' };
    const first = await handle('/sign-up/email', payload);
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(generic);
    expect(tasks).toHaveLength(1);
    expect(mail).toHaveLength(0);
    const duplicate = await handle('/sign-up/email', payload);
    const rejected = await handle('/sign-up/email', { ...payload, email: 'outsider@example.test' });
    expect(await duplicate.json()).toEqual(generic);
    expect(await rejected.json()).toEqual(generic);
    expect(await db.select().from(user)).toHaveLength(1);
    const [storedUser] = await db.select().from(user);
    expect(storedUser.emailVerified).toBe(false);
    expect(storedUser.id).not.toBe('forged');
    const [credential] = await db.select().from(account);
    expect(credential.password).not.toContain(password);
    expect(credential.password!.length).toBeGreaterThan(64);
    const denied = await handle('/sign-in/email', { email: emailA, password });
    expect(denied.status).toBe(403);
    expect(tasks).toHaveLength(1); // sendOnSignIn is explicitly false.
    expect(await db.select().from(session)).toHaveLength(0);
  });

  it('verifies a real token and signs in/out through the installed Next handler shape', async () => {
    const owner = await enroll(emailA);
    const { cookie } = await login(emailA);
    expect(await requireApplicant(request('/applicant'), auth)).toBeInstanceOf(Response);
    expect(await requireApplicant(request('/applicant', undefined, cookie), auth)).toEqual({
      ownerId: owner.id, email: emailA, name: owner.name,
    });
    const out = await handle('/sign-out', {}, cookie);
    expect(out.status).toBe(200);
    expect((await requireApplicant(request('/applicant', undefined, cookie), auth) as Response).status).toBe(401);
  });

  it('runs the actual React client signup/sign-in/sign-out calls through the real HTTP factory', async () => {
    let cookie = '';
    const paths: string[] = [];
    const client = createAuthClient({
      baseURL,
      fetchOptions: {
        cache: 'no-store',
        // Installed better-fetch customFetchImpl replaces transport only, not auth behavior.
        customFetchImpl: async (url, init) => {
          const headers = new Headers(init?.headers);
          headers.set('origin', baseURL);
          if (cookie) headers.set('cookie', cookie);
          const req = new Request(url, { ...init, headers });
          paths.push(new URL(req.url).pathname);
          const response = await handleAuthRequest(req, () => auth);
          const sessionCookie = response.headers.getSetCookie().find((entry) => entry.startsWith('__Secure-workie.session_token='));
          if (sessionCookie) cookie = sessionCookie.split(';')[0];
          return response;
        },
      },
    });
    const signup = await client.signUp.email({ email: emailA, password, name: 'Alice', callbackURL: '/sign-in' });
    expect(signup.error).toBeNull();
    await drain();
    expect((await handleAuthRequest(new Request(mail[0].url), () => auth)).status).toBe(302);
    expect((await client.signIn.email({ email: emailA, password })).error).toBeNull();
    expect(await requireApplicant(request('/applicant', undefined, cookie), auth)).toMatchObject({ email: emailA });
    expect((await client.signOut()).error).toBeNull();
    expect((await requireApplicant(request('/applicant', undefined, cookie), auth) as Response).status).toBe(401);
    expect(paths).toEqual(['/api/auth/sign-up/email', '/api/auth/sign-in/email', '/api/auth/sign-out']);
  });

  it('rechecks verification and the current allowlist for existing sessions and returning sign-ins', async () => {
    const owner = await enroll(emailA);
    const { cookie } = await login(emailA);
    allowedEmails = [emailB];
    expect((await requireApplicant(request('/applicant', undefined, cookie), auth) as Response).status).toBe(403);
    expect((await handle('/get-session', undefined, cookie)).status).toBe(403);
    expect((await handle('/sign-in/email', { email: emailA, password })).status).toBe(403);
    allowedEmails = [emailA, emailB];
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, owner.id));
    expect((await requireApplicant(request('/applicant', undefined, cookie), auth) as Response).status).toBe(403);
  });

  it('rejects absent/forged/expired/revoked sessions and shared note/send credentials', async () => {
    const owner = await enroll(emailA);
    const { cookie, token } = await login(emailA);
    const bogus = request('/applicant');
    bogus.headers.set('x-workie-token', 'synthetic-note-key');
    bogus.headers.set('x-workie-send-token', 'synthetic-send-key');
    bogus.headers.set('authorization', 'Bearer synthetic-shared-key');
    expect((await requireApplicant(bogus, auth) as Response).status).toBe(401);
    expect((await requireApplicant(request('/applicant', undefined, `${cookie}tampered`), auth) as Response).status).toBe(401);
    await db.update(session).set({ expiresAt: new Date(Date.now() - 1_000) }).where(eq(session.token, token));
    expect((await requireApplicant(request('/applicant', undefined, cookie), auth) as Response).status).toBe(401);
    const current = await login(emailA);
    await db.delete(session).where(eq(session.userId, owner.id));
    expect((await requireApplicant(request('/applicant', undefined, current.cookie), auth) as Response).status).toBe(401);
  });

  it('derives ownership only from the session and cannot revoke a second user session', async () => {
    const a = await enroll(emailA);
    const b = await enroll(emailB);
    const sessionA = await login(emailA);
    const sessionB = await login(emailB);
    const forged = request(`/api/private?ownerId=${b.id}`, { ownerId: b.id }, sessionA.cookie);
    forged.headers.set('x-owner-id', b.id);
    expect(await requireApplicant(forged, auth)).toMatchObject({ ownerId: a.id, email: emailA });
    const listed = await handle('/list-sessions', undefined, sessionA.cookie);
    expect(listed.status).toBe(200);
    const entries = await listed.json();
    expect(entries).toHaveLength(1);
    expect(entries[0].userId).toBe(a.id);
    const forbiddenRevoke = await handle('/revoke-session', { token: sessionB.token }, sessionA.cookie);
    // v1.7.5 deliberately reports opaque success for a token owned by someone else.
    expect(forbiddenRevoke.status).toBe(200);
    expect(await requireApplicant(request('/applicant', undefined, sessionB.cookie), auth)).toMatchObject({ ownerId: b.id });
    expect((await handle('/revoke-session', { token: sessionA.token }, sessionA.cookie)).status).toBe(200);
    expect((await requireApplicant(request('/applicant', undefined, sessionA.cookie), auth) as Response).status).toBe(401);
  });

  it('rejects the unused revoke-other-sessions surface above 100 sessions and preserves signout/revoke-all', async () => {
    const a = await enroll(emailA);
    const b = await enroll(emailB);
    const current = await login(emailA);
    const other = await login(emailB);
    await addSessions(a.id, 110);
    expect(await db.select().from(session).where(eq(session.userId, a.id))).toHaveLength(111);
    const rejected = await handle('/revoke-other-sessions', {}, current.cookie);
    expect(rejected.status).toBe(404);
    expect(await rejected.json()).toEqual({ error: 'Not found.' });
    expect(await db.select().from(session).where(eq(session.userId, a.id))).toHaveLength(111);
    expect((await handle('/sign-out', {}, current.cookie)).status).toBe(200);
    expect(await db.select().from(session).where(eq(session.userId, a.id))).toHaveLength(110);
    const replacement = await login(emailA);
    expect((await handle('/revoke-sessions', {}, replacement.cookie)).status).toBe(200);
    expect(await db.select().from(session).where(eq(session.userId, a.id))).toHaveLength(0);
    expect(await requireApplicant(request('/applicant', undefined, other.cookie), auth)).toMatchObject({ ownerId: b.id });
  });

  it('rejects varied reset-token callback paths before they can grow the limiter table', async () => {
    const statuses = [];
    for (let index = 0; index < 120; index++) {
      statuses.push((await handle(`/reset-password/synthetic-${index}?callbackURL=/sign-in`)).status);
    }
    expect.soft([...new Set(statuses)]).toEqual([404]);
    expect(await db.select().from(rateLimit)).toHaveLength(0);
  });

  it('schedules manual resends and reset mail, returns uniform responses, consumes reset tokens and revokes sessions', async () => {
    await handle('/sign-up/email', { email: emailA, password, name: 'Alice' });
    const resend = await handle('/send-verification-email', { email: emailA, callbackURL: '/sign-in' });
    const absent = await handle('/send-verification-email', { email: 'missing@example.test', callbackURL: '/sign-in' });
    expect(await resend.json()).toEqual(generic);
    expect(await absent.json()).toEqual(generic);
    expect(tasks).toHaveLength(2);
    expect(mail).toHaveLength(0);
    await drain();
    expect((await handleAuthRequest(new Request(mail[0].url), () => auth)).status).toBe(302);
    const old = await login(emailA);
    const another = await login(emailA);
    const [owner] = await db.select().from(user).where(eq(user.email, emailA));
    await addSessions(owner.id, 110);
    const reset = await handle('/request-password-reset', { email: emailA, redirectTo: '/different-local-path' });
    const absentReset = await handle('/request-password-reset', { email: 'missing@example.test', redirectTo: '/sign-in?mode=reset' });
    expect(await reset.json()).toEqual(generic);
    expect(await absentReset.json()).toEqual(generic);
    expect(tasks).toHaveLength(1);
    await drain();
    const message = mail.find((entry) => entry.kind === 'reset')!;
    const link = new URL(message.url);
    expect(link.origin).toBe(baseURL);
    expect(link.pathname).toBe('/sign-in');
    expect(link.searchParams.get('mode')).toBe('reset');
    const token = link.searchParams.get('token')!;
    expect(token).toBeTruthy();
    const newPassword = `${password}-changed`;
    expect((await handle('/reset-password', { token, newPassword })).status).toBe(200);
    expect(await db.select().from(session)).toHaveLength(0);
    expect((await handle('/reset-password', { token, newPassword })).status).toBe(400);
    expect((await requireApplicant(request('/applicant', undefined, old.cookie), auth) as Response).status).toBe(401);
    expect((await requireApplicant(request('/applicant', undefined, another.cookie), auth) as Response).status).toBe(401);
    // Separate credential checks from the rate-limit assertions below.
    await db.delete(rateLimit);
    expect((await handle('/sign-in/email', { email: emailA, password })).status).toBe(401);
    expect((await handle('/sign-in/email', { email: emailA, password: newPassword })).status).toBe(200);
  });

  it('rejects invalid verification and expired reset tokens without changing the password', async () => {
    await enroll(emailA);
    expect((await handle('/verify-email?token=forged')).status).toBe(401);
    await handle('/request-password-reset', { email: emailA, redirectTo: '/sign-in?mode=reset' });
    await drain();
    const reset = mail.find((entry) => entry.kind === 'reset')!;
    const token = new URL(reset.url).searchParams.get('token')!;
    expect(token).toBeTruthy();
    await db.update(verification).set({ expiresAt: new Date(Date.now() - 1_000) });
    expect((await handle('/reset-password', { token, newPassword: `${password}-new` })).status).toBe(400);
    await login(emailA);
  });

  it('rejects an expired email-verification link without verifying or creating a session', async () => {
    await handle('/sign-up/email', { email: emailA, password, name: 'Alice' });
    await drain();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 3_601_000);
    const response = await handleAuthRequest(new Request(mail[0].url), () => auth);
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toContain('TOKEN_EXPIRED');
    expect((await db.select().from(user))[0].emailVerified).toBe(false);
    expect(await db.select().from(session)).toHaveLength(0);
  });

  it('denies CSRF including first-login/missing-origin requests and untrusted redirect targets', async () => {
    const payload = { email: emailA, password, name: 'Alice' };
    for (const origin of [null, 'https://evil.example.test', `${baseURL}.evil.test`, 'null']) {
      expect((await handle('/sign-up/email', payload, '', origin)).status).toBe(403);
    }
    const crossSite = request('/sign-up/email', payload);
    crossSite.headers.set('sec-fetch-site', 'cross-site');
    expect((await handleAuthRequest(crossSite, () => auth)).status).toBe(403);
    expect((await handle('/sign-up/email', { ...payload, callbackURL: 'https://evil.example.test' })).status).toBe(403);
    // Exercise upstream protection too, not just Workie's stricter same-origin wrapper.
    expect((await auth.handler(request('/sign-up/email', payload, '', 'https://evil.example.test'))).status).toBe(403);
    expect(await db.select().from(user)).toHaveLength(0);
    await enroll(emailA);
    const current = await login(emailA);
    expect((await requireApplicant(request('/private', {}, current.cookie, null), auth) as Response).status).toBe(403);
  });

  it('enforces database-backed HTTP rate limits even in test mode and without a client-IP header', async () => {
    for (let index = 0; index < 3; index++) {
      expect((await handle('/sign-in/email', { email: emailA, password })).status).toBe(401);
    }
    const throttled = await handle('/sign-in/email', { email: emailA, password });
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('cache-control')).toBe('private, no-store');
    const rows = await db.select().from(rateLimit);
    expect(rows.some((row) => row.count === 3)).toBe(true);
    expect(auth.options.rateLimit).toEqual({ enabled: true, storage: 'database', window: 60, max: 100 });
    expect(auth.options.advanced).toMatchObject({ disableOriginCheck: false, disableCSRFCheck: false });
  });

  it('bounds chunked bodies and rejects unsupported media types before authentication', async () => {
    const oversized = request('/sign-up/email', { email: emailA, password, name: 'x'.repeat(17_000) });
    expect(oversized.headers.has('content-length')).toBe(false);
    expect((await handleAuthRequest(oversized, () => auth)).status).toBe(413);
    const form = new Request(`${baseURL}/api/auth/sign-in/email`, {
      method: 'POST', headers: { origin: baseURL, 'content-type': 'text/plain' }, body: '{}',
    });
    expect((await handleAuthRequest(form, () => auth)).status).toBe(415);
    expect(await db.select().from(user)).toHaveLength(0);
  });

  it('uses the real narrow applicant endpoint without sharing session tokens or cached responses', async () => {
    const a = await enroll(emailA);
    const b = await enroll(emailB);
    const one = await login(emailA);
    const two = await login(emailB);
    vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
    const { GET } = await import('@/app/api/auth/applicant/route');
    const first = await GET(request('/applicant', undefined, one.cookie));
    const second = await GET(request('/applicant', undefined, two.cookie));
    expect(await first.json()).toEqual({ ownerId: a.id, email: emailA, name: a.name });
    expect(await second.json()).toEqual({ ownerId: b.id, email: emailB, name: b.name });
    for (const response of [first, second, await GET(request('/applicant'))]) {
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vercel-cdn-cache-control')).toBe('no-store');
      expect(response.headers.get('cdn-cache-control')).toBe('no-store');
      expect(response.headers.get('vary')).toContain('Cookie');
    }
  });

  it('preserves every upstream deletion cookie when normalizing a revoked signed-cookie resend', async () => {
    await enroll(emailA);
    const current = await login(emailA);
    await db.delete(session).where(eq(session.token, current.token));
    const payload = { email: 'missing@example.test', callbackURL: '/sign-in' };
    const upstream = await auth.handler(request('/send-verification-email', payload, current.cookie));
    expect(upstream.status).toBe(200);
    const deletions = upstream.headers.getSetCookie();
    expect(deletions.length).toBeGreaterThanOrEqual(3);
    expect(deletions.every((cookie) => cookie.includes('Max-Age=0'))).toBe(true);
    const normalized = await handle('/send-verification-email', payload, current.cookie);
    expect(normalized.status).toBe(upstream.status);
    expect(normalized.headers.getSetCookie()).toEqual(deletions);
    expect(await normalized.json()).toEqual(generic);
  });

  it('retains upstream success status and headers but drops obsolete body metadata during normalization', async () => {
    const realHandler = auth.handler;
    vi.spyOn(auth, 'handler').mockImplementation(async (req) => {
      const upstream = await realHandler(req);
      const headers = new Headers(upstream.headers);
      headers.set('X-Synthetic-Upstream', 'preserved');
      headers.set('Content-Length', '999');
      headers.set('Content-Encoding', 'gzip');
      headers.append('Set-Cookie', 'synthetic-one=; Max-Age=0');
      headers.append('Set-Cookie', 'synthetic-two=; Max-Age=0');
      return new Response(upstream.body, { status: 202, statusText: 'Accepted', headers });
    });
    const response = await handle('/request-password-reset', { email: 'missing@example.test' });
    expect(response.status).toBe(202);
    expect(response.statusText).toBe('Accepted');
    expect(response.headers.get('x-synthetic-upstream')).toBe('preserved');
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.getSetCookie()).toEqual(['synthetic-one=; Max-Age=0', 'synthetic-two=; Max-Age=0']);
    expect(await response.json()).toEqual(generic);
  });

  it('limits the actual applicant endpoint and private guards through one fixed HTTP session bucket', async () => {
    const owner = await enroll(emailA);
    const current = await login(emailA);
    vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
    const { GET } = await import('@/app/api/auth/applicant/route');
    await db.delete(rateLimit);
    const http = vi.spyOn(auth, 'handler');
    for (let index = 0; index < 100; index++) {
      const response = await GET(request(`/api/auth/applicant?ownerId=forged-${index}`, undefined, current.cookie));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ownerId: owner.id, email: emailA, name: owner.name });
    }
    expect(http).toHaveBeenCalledTimes(100);
    expect(http.mock.calls.every(([req]) =>
      req instanceof Request && req.method === 'GET' &&
      req.url === `${baseURL}/api/auth/get-session?disableCookieCache=true&disableRefresh=true`,
    )).toBe(true);
    const throttled = await GET(request('/applicant', undefined, current.cookie));
    expect(throttled.status).toBe(429);
    expect(Number(throttled.headers.get('x-retry-after'))).toBeGreaterThan(0);
    expect(throttled.headers.get('cache-control')).toBe('private, no-store');
    expect(await throttled.text()).not.toContain(emailA);
    const guarded = await requireApplicant(new Headers({ cookie: current.cookie }), auth);
    expect(guarded).toBeInstanceOf(Response);
    expect((guarded as Response).status).toBe(429);
    expect((await handle('/get-session', undefined, current.cookie)).status).toBe(429);
    const rows = await db.select().from(rateLimit);
    expect(rows).toHaveLength(1);
    expect(rows[0].count).toBe(100);
  });

  it('preserves stale-cookie clears and denies missing/unlisted identity at the actual applicant endpoint', async () => {
    await enroll(emailA);
    const current = await login(emailA);
    vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
    const { GET } = await import('@/app/api/auth/applicant/route');
    allowedEmails = [emailB];
    const forbidden = await GET(request('/applicant', undefined, current.cookie));
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: 'Applicant access is not permitted.' });
    allowedEmails = [emailA, emailB];
    await db.delete(session).where(eq(session.token, current.token));
    const upstream = await auth.handler(request('/get-session?disableCookieCache=true&disableRefresh=true', undefined, current.cookie));
    const stale = await GET(request('/applicant', undefined, current.cookie));
    expect(stale.status).toBe(401);
    expect(stale.headers.getSetCookie()).toEqual(upstream.headers.getSetCookie());
    expect(stale.headers.getSetCookie().length).toBeGreaterThanOrEqual(3);
    expect(await stale.json()).toEqual({ error: 'Sign in required.' });
    await db.delete(rateLimit);
    for (let index = 0; index < 100; index++) {
      const missing = await GET(request('/applicant'));
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: 'Sign in required.' });
    }
    expect((await GET(request('/applicant'))).status).toBe(429);
  });

  it('keeps applicant reads non-refreshing, clears obsolete cached chunks, and looks up get-session only once', async () => {
    const owner = await enroll(emailA);
    const current = await login(emailA);
    const expiresAt = new Date(Date.now() + 3_600_000);
    const updatedAt = new Date(Date.now() - 86_400_000);
    await db.update(session).set({ expiresAt, updatedAt }).where(eq(session.token, current.token));
    const cookie = `${current.cookie}; __Secure-workie.session_data.0=obsolete; __Secure-workie.session_data.1=obsolete`;
    vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
    const { GET } = await import('@/app/api/auth/applicant/route');
    await db.delete(rateLimit);
    const response = await GET(request('/api/auth/applicant?disableRefresh=false&disableCookieCache=false', undefined, cookie));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ownerId: owner.id, email: emailA, name: owner.name });
    const cookies = response.headers.getSetCookie();
    for (const suffix of ['.0', '.1']) {
      expect(cookies.some((entry) => entry.startsWith(`__Secure-workie.session_data${suffix}=`) && entry.includes('Max-Age=0'))).toBe(true);
    }
    const sdkResponse = await handle('/get-session', undefined, cookie);
    expect(sdkResponse.status).toBe(200);
    expect(await sdkResponse.json()).toMatchObject({ session: { userId: owner.id }, user: { id: owner.id } });
    const [stored] = await db.select().from(session).where(eq(session.token, current.token));
    expect(stored.expiresAt).toEqual(expiresAt);
    expect(stored.updatedAt).toEqual(updatedAt);
    expect((await db.select().from(rateLimit)).map((row) => row.count)).toEqual([2]);
  });

  it('fails closed on malformed SDK identity and preserves cookie clears and upstream errors', async () => {
    vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
    const { GET } = await import('@/app/api/auth/applicant/route');
    const handler = vi.spyOn(auth, 'handler');
    const headers = new Headers({ 'X-Synthetic-Upstream': 'preserved' });
    headers.append('Set-Cookie', 'synthetic-one=; Max-Age=0');
    headers.append('Set-Cookie', 'synthetic-two=; Max-Age=0');
    for (const body of [
      '{invalid-json',
      JSON.stringify({ user: { id: 'synthetic', email: emailA, emailVerified: true } }),
      JSON.stringify({ user: { id: 'synthetic', name: 'Alice', email: emailA, emailVerified: true }, session: { userId: 'someone-else' } }),
    ]) {
      handler.mockResolvedValueOnce(new Response(body, { headers }));
      const response = await GET(request('/applicant'));
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
      expect(await response.json()).toEqual({ error: 'Applicant authentication is unavailable.' });
    }
    handler.mockResolvedValueOnce(Response.json({ error: 'SDK rejected request.' }, { status: 400, headers }));
    const rejected = await GET(request('/applicant'));
    expect(rejected.status).toBe(400);
    expect(rejected.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(await rejected.json()).toEqual({ error: 'SDK rejected request.' });
    handler.mockResolvedValueOnce(Response.json({ error: 'synthetic-secret' }, { status: 500, headers }));
    const unavailable = await GET(request('/applicant'));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.getSetCookie()).toEqual(headers.getSetCookie());
    expect(await unavailable.text()).not.toContain('synthetic-secret');
  });

  it('sanitizes unavailable configuration/database and deferred mail failures', async () => {
    const unavailable = await handleAuthRequest(request('/get-session'), () => {
      throw new Error('synthetic-secret database token');
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).not.toContain('synthetic-secret');
    auth = createAuth(config, db, {
      sendMail: async () => { throw new Error('synthetic-secret smtp password'); },
      scheduleMail: (task) => { tasks.push(task); },
    });
    const signup = await handle('/sign-up/email', { email: emailA, password, name: 'Alice' });
    expect(await signup.json()).toEqual(generic);
    await expect(drain()).rejects.toThrow('Authentication email delivery failed.');
    db.$client.close();
    expect((await requireApplicant(request('/applicant'), auth) as Response).status).toBe(503);
    expect((await handle('/sign-in/email', { email: emailA, password })).status).toBe(503);
  });

  it('does not silently fall back to fire-and-forget outside a Next after request context', async () => {
    const productionScheduler = createAuth(config, db, {
      sendMail: async (message) => { mail.push(message); },
    });
    await expect(productionScheduler.options.emailVerification.sendVerificationEmail({
      user: { id: 'synthetic', email: emailA, emailVerified: false, name: 'Alice', createdAt: new Date(), updatedAt: new Date() },
      url: `${baseURL}/synthetic`, token: 'synthetic',
    })).rejects.toThrow('outside a request scope');
    expect(mail).toHaveLength(0);
  });
});

describe('configuration and private response boundaries', () => {
  it('rejects missing/unsafe configuration equally in local and hosted modes without including values', () => {
    const env = {
      BETTER_AUTH_URL: baseURL, BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
      WORKIE_APPLICANT_EMAIL_ALLOWLIST: `${emailA}, ${emailB.toUpperCase()}`,
      WORKIE_AUTH_MAIL_FROM: 'auth@example.test',
    };
    expect(readAuthConfig(env).allowedEmails).toEqual([emailA, emailB]);
    expect(readAuthConfig({ ...env, BETTER_AUTH_URL: 'http://127.0.0.1:3000' }).baseURL).toBe('http://127.0.0.1:3000');
    for (const value of [
      {}, { ...env, BETTER_AUTH_SECRET: 'synthetic-secret' },
      { ...env, WORKIE_AUTH_MAIL_FROM: '' },
      { ...env, WORKIE_APPLICANT_EMAIL_ALLOWLIST: '' },
      { ...env, BETTER_AUTH_URL: 'https://user:synthetic-secret@workie.example.test/' },
      { ...env, BETTER_AUTH_URL: 'http://workie.example.test' },
      { ...env, BETTER_AUTH_URL: 'https://workie.example.test/path' },
      { ...env, BETTER_AUTH_URL: 'http://localhost:3000', VERCEL: '1' },
    ]) {
      expect(() => readAuthConfig(value)).toThrow('Applicant authentication is unavailable.');
    }
  });

  it('imports actual routes without environment/configuration and returns private 503 instead of initializing on import', async () => {
    for (const key of ['BETTER_AUTH_URL', 'BETTER_AUTH_SECRET', 'WORKIE_APPLICANT_EMAIL_ALLOWLIST', 'WORKIE_AUTH_MAIL_FROM', 'WORKIE_PRIVATE_DATABASE_URL']) {
      vi.stubEnv(key, '');
    }
    const { GET, POST } = await import('@/app/api/auth/[...all]/route');
    const { GET: applicantGET } = await import('@/app/api/auth/applicant/route');
    for (const response of [
      await GET(request('/get-session')),
      await POST(request('/sign-in/email', { email: emailA, password })),
      await applicantGET(request('/applicant')),
    ]) {
      expect(response.status).toBe(503);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
  });

  it('fails private routes closed when auth is configured but the private database is missing', async () => {
    vi.stubEnv('BETTER_AUTH_URL', baseURL);
    vi.stubEnv('BETTER_AUTH_SECRET', config.secret);
    vi.stubEnv('WORKIE_APPLICANT_EMAIL_ALLOWLIST', emailA);
    vi.stubEnv('WORKIE_AUTH_MAIL_FROM', config.mailFrom);
    vi.stubEnv('WORKIE_PRIVATE_DATABASE_URL', '');
    const { GET } = await import('@/app/api/auth/applicant/route');
    for (const hosted of ['', '1']) {
      vi.stubEnv('VERCEL', hosted);
      const response = await GET(request('/applicant'));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: 'Applicant authentication is unavailable.' });
    }
  });

  it('overrides shared cache headers while preserving Vary and multiple Set-Cookie headers', () => {
    const headers = new Headers({
      'Vary': 'Accept-Encoding',
      'Cache-Control': 'public, max-age=300',
      'Vercel-CDN-Cache-Control': 'max-age=300',
    });
    headers.append('Set-Cookie', 'one=1; HttpOnly');
    headers.append('Set-Cookie', 'two=2; HttpOnly');
    const result = privateResponse(new Response(null, { headers }));
    expect(result.headers.getSetCookie()).toEqual(['one=1; HttpOnly', 'two=2; HttpOnly']);
    expect(result.headers.get('vary')).toBe('Accept-Encoding, Cookie, Origin');
    expect(result.headers.get('cache-control')).toBe('private, no-store');
    expect(privateJson({ ok: true }).headers.get('referrer-policy')).toBe('no-referrer');
  });
});
