import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as authModule from '../auth.ts';
import * as dbModule from '../private-db/index.ts';
import { handleAuthRequest } from '../auth-http.ts';
import type { AuthMail } from '../auth-mail.ts';
import { user, session, workers, workerPairings, policyHeads, policyVersions, applicationRuns, applications, rateLimit } from '../private-db/schema.ts';
import { POST as createPairingRoute } from '../../app/api/workers/pairings/route.ts';
import { GET as listWorkersRoute } from '../../app/api/workers/route.ts';
import { POST as pairRoute } from '../../app/api/worker/pair/route.ts';
import { POST as pollRoute } from '../../app/api/worker/poll/route.ts';
import { POST as heartbeatRoute } from '../../app/api/worker/heartbeat/route.ts';
import { POST as providerConfigRoute } from '../../app/api/worker/provider-config/route.ts';
import { DELETE as revokeRoute } from '../../app/api/workers/[id]/route.ts';
import { POST as createRunRoute } from '../../app/api/application-runs/route.ts';
import { enqueueApplication } from './runs.ts';
import { createEmptyPolicy } from './policy.ts';
import { hashValue } from './stores.ts';
import { ProviderConfigSchema } from './provider-protocol.ts';
import * as p from './worker-protocol.ts';

vi.mock('server-only', () => ({}));
let db: dbModule.PrivateDb, auth: authModule.ApplicantAuth, dir: string, origin: string, server: Server;
let mail: AuthMail[], scheduled: (() => Promise<void>)[], allowed: string[];
let alice: { id: string; cookie: string }, bob: { id: string; cookie: string };
const password = 'synthetic-password-fixture-only-123';
const nativeFetch = globalThis.fetch;
const fresh = (expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision });
async function drain() { while (scheduled.length) await scheduled.shift()!(); }
async function http(path: string, body?: unknown, cookie = '', extra: Record<string, string> = {}) {
  return fetch(`${origin}${path}`, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { origin, ...body === undefined ? {} : { 'content-type': 'application/json' }, cookie, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function enroll(email: string) {
  expect((await http('/api/auth/sign-up/email', { email, password, name: 'Synthetic applicant' })).status).toBe(200);
  await drain();
  const link = mail.findLast((entry) => entry.kind === 'verification' && entry.to === email)!.url;
  expect((await fetch(link, { redirect: 'manual' })).status).toBe(302);
  const response = await http('/api/auth/sign-in/email', { email, password });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find((entry) => entry.startsWith('workie.session_token='))!.split(';')[0];
  const [owner] = await db.select().from(user).where(eq(user.email, email));
  return { id: owner.id, cookie };
}
async function paired(owner = alice) {
  const approved = await http('/api/workers/pairings', { ...fresh(), label: 'Synthetic host' }, owner.cookie,
    { 'x-workie-applicant': owner.id });
  expect(approved.status).toBe(200);
  const grant = p.PairingGrantSchema.parse(await approved.json());
  const input: p.PairRequest = { protocolVersion: 1, requestId: randomUUID(), workerId: randomUUID(), grant: grant.grant,
    workerToken: randomBytes(32).toString('base64url'), workerVersion: '0.1.0', capabilities: ['control-v1'] };
  const response = await http('/api/worker/pair', input);
  expect(response.status).toBe(200);
  return { ...p.PairResponseSchema.parse(await response.json()), input, token: input.workerToken, grant };
}
async function running(workerId: string) {
  const policy = createEmptyPolicy(), hash = hashValue(policy), now = Date.now();
  await db.insert(policyVersions).values({ ownerId: alice.id, version: 1, policy, hash, createdAt: now });
  await db.insert(policyHeads).values({ ownerId: alice.id, revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  const created = await http('/api/application-runs', { ...fresh(), workerId }, alice.cookie, { 'x-workie-applicant': alice.id });
  expect(created.status).toBe(200);
  const run = p.RunSchema.parse(await created.json());
  await enqueueApplication(db, alice.id, run.id, { ats: 'fixture', tenant: 'synthetic', requisition: 'role' });
  return run;
}
async function poll(token: string) {
  return http('/api/worker/poll', { protocolVersion: 1 }, '', { authorization: `Bearer ${token}` });
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase3-http-'));
  db = dbModule.openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await dbModule.migratePrivateDb(db);
  mail = []; scheduled = []; allowed = ['alice@example.test', 'bob@example.test'];
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const request = new Request(`${origin}${req.url}`, { method: req.method, headers,
        body: ['GET', 'HEAD'].includes(req.method!) ? undefined : Buffer.concat(chunks) });
      const path = new URL(request.url).pathname;
      let response: Response;
      if (path.startsWith('/api/auth/')) response = await handleAuthRequest(request, () => auth);
      else if (path === '/api/workers/pairings') response = await createPairingRoute(request);
      else if (path === '/api/workers') response = await listWorkersRoute(request);
      else if (path === '/api/worker/pair') response = await pairRoute(request);
      else if (path === '/api/worker/poll') response = await pollRoute(request);
      else if (path === '/api/worker/heartbeat') response = await heartbeatRoute(request);
      else if (path === '/api/worker/provider-config') response = await providerConfigRoute(request);
      else if (path === '/api/application-runs') response = await createRunRoute(request);
      else response = new Response(null, { status: 404 });
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('Synthetic fixture error'); }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(url instanceof Request ? url.url : url);
    if (target.origin !== origin) throw new Error('External network forbidden.');
    return nativeFetch(url, init);
  });
  auth = authModule.createAuth({
    baseURL: origin, secret: randomBytes(32).toString('hex'), mailFrom: 'auth@example.test', allowedEmails: allowed,
  }, db, { sendMail: async (message) => { mail.push(message); }, scheduleMail: (task) => { scheduled.push(task); }, allowedEmails: () => allowed });
  vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
  vi.spyOn(dbModule, 'getPrivateDb').mockReturnValue(db);
  alice = await enroll('alice@example.test');
  bob = await enroll('bob@example.test');
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
});
describe('Phase 3 real route handlers over loopback with Better Auth 1.7.5', () => {
  it('requires session owner precondition and origin, rejects owner authority and never returns credential material', async () => {
    const deniedHeaders: Record<string, string>[] = [{}, { 'x-workie-applicant': bob.id }, { 'x-workie-applicant': alice.id, origin: 'https://evil.example.test' }];
    for (const headers of deniedHeaders) {
      expect((await http('/api/workers/pairings', { ...fresh(), label: 'Host' }, alice.cookie, headers)).status).toBe(403);
    }
    expect((await http('/api/workers/pairings', { ...fresh(), label: 'Host', ownerId: bob.id }, alice.cookie,
      { 'x-workie-applicant': alice.id })).status).toBe(400);
    expect((await http('/api/workers/pairings', { ...fresh(), label: 'Host' }, '', { 'x-workie-applicant': alice.id })).status).toBe(401);
    const worker = await paired();
    const response = await http('/api/workers', undefined, alice.cookie);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('cdn-cache-control')).toBe('no-store');
    const text = await response.text();
    const summary = p.WorkerListSchema.parse(JSON.parse(text));
    expect(summary.workers).toHaveLength(1);
    for (const forbidden of [worker.token, worker.grant.grant, 'credentialBinding', 'tokenHash', 'password']) expect(text).not.toContain(forbidden);
    expect(p.WorkerListSchema.parse(await (await http('/api/workers', undefined, bob.cookie)).json()).workers).toEqual([]);
    const forged = await http('/api/worker/poll', { protocolVersion: 1 }, alice.cookie,
      { 'x-workie-send-token': 'synthetic-shared', authorization: 'Bearer synthetic-session' });
    expect(forged.status).toBe(401);
    expect((await http('/api/worker/pair', { ...worker.input, ownerId: bob.id })).status).toBe(400);
    const denied = await revokeRoute(new Request(`${origin}/api/workers/${worker.workerId}`, { method: 'DELETE',
      headers: { origin, cookie: bob.cookie, 'content-type': 'application/json', 'x-workie-applicant': bob.id }, body: JSON.stringify(fresh(1)) }),
    { params: Promise.resolve({ id: worker.workerId }) });
    expect(denied.status).toBe(404);
  });
  it('returns an owner-scoped provider config and fails closed before any provider credential is involved', async () => {
    const worker = await paired();
    const response = await http('/api/worker/provider-config', { protocolVersion: 1, providerProtocolVersion: 1 }, '',
      { authorization: `Bearer ${worker.token}` });
    expect(response.status).toBe(200);
    const config = ProviderConfigSchema.parse(await response.json());
    expect(config).toMatchObject({ ownerId: alice.id, enabled: false, provider: 'none', maxUsd: 0 });
    expect((await http('/api/worker/provider-config', { protocolVersion: 1, providerProtocolVersion: 1 }, '',
      { authorization: `Bearer ${randomBytes(32).toString('base64url')}` })).status).toBe(401);
    expect((await http('/api/worker/provider-config', { protocolVersion: 2, providerProtocolVersion: 1 }, '',
      { authorization: `Bearer ${worker.token}` })).status).toBe(426);
  });
  it('ordinary logout leaves worker valid; actual reset consumes the token, deletes sessions, revokes workers and pauses leases', async () => {
    const worker = await paired();
    const run = await running(worker.workerId);
    const lease = p.PollResponseSchema.parse(await (await poll(worker.token)).json()).lease!;
    expect((await http('/api/auth/sign-out', {}, alice.cookie)).status).toBe(200);
    expect((await poll(worker.token)).status).toBe(200);
    expect((await http('/api/auth/request-password-reset', { email: 'alice@example.test', redirectTo: '/sign-in?mode=reset' })).status).toBe(200);
    await drain();
    const reset = mail.findLast((message) => message.kind === 'reset')!;
    const token = new URL(reset.url).searchParams.get('token')!;
    expect((await http('/api/auth/reset-password', { token, newPassword: `${password}-new` })).status).toBe(200);
    expect(await db.select().from(session).where(eq(session.userId, alice.id))).toEqual([]);
    expect((await http('/api/auth/reset-password', { token, newPassword: `${password}-new` })).status).toBe(400);
    expect((await poll(worker.token)).status).toBe(401);
    const heartbeat = await http('/api/worker/heartbeat', { protocolVersion: 1, lease: {
      applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision,
    } }, '', { authorization: `Bearer ${worker.token}` });
    expect(heartbeat.status).toBe(401);
    expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, run.id)))[0].state).toBe('paused');
    expect((await db.select().from(applications))[0].leaseUntil).toBeNull();
    expect((await db.select().from(workers))[0].revokedAt).not.toBeNull();
    expect((await db.select().from(workerPairings))[0].revokedAt).not.toBeNull();
    expect((await http('/api/workers', undefined, bob.cookie)).status).toBe(200);
  });
  it('the installed real password-change flow invalidates prior worker credentials without a reset hook', async () => {
    const worker = await paired();
    const approved = await http('/api/workers/pairings', { ...fresh(), label: 'Unconsumed host' }, alice.cookie,
      { 'x-workie-applicant': alice.id });
    const pending = p.PairingGrantSchema.parse(await approved.json());
    // Workie's public wrapper deliberately does not expose change-password yet.
    // Exercise the installed handler, not a mock mutation of the credential table.
    const changed = await auth.handler(new Request(`${origin}/api/auth/change-password`, {
      method: 'POST', headers: { origin, cookie: alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: password, newPassword: `${password}-changed`, revokeOtherSessions: true }),
    }));
    expect(changed.status).toBe(200);
    expect('onPasswordReset' in auth.options.emailAndPassword).toBe(false);
    expect((await http('/api/worker/pair', { ...worker.input, requestId: randomUUID(), workerId: randomUUID(),
      workerToken: randomBytes(32).toString('base64url'), grant: pending.grant })).status).toBe(401);
    expect((await db.select().from(workerPairings).where(eq(workerPairings.id, pending.pairingId)))[0].revokedAt).not.toBeNull();
    expect((await poll(worker.token)).status).toBe(401);
  });
  it('rejects unsupported versions, oversized bodies and unsupported media, and applies durable bounded rate buckets', async () => {
    const worker = await paired();
    expect((await http('/api/worker/poll', { protocolVersion: 2 }, '', { authorization: `Bearer ${worker.token}` })).status).toBe(426);
    expect((await http('/api/worker/pair', { ...worker.input, capabilities: ['submit-anything'] })).status).toBe(426);
    expect((await http('/api/worker/poll', { protocolVersion: 1, oversized: 'x'.repeat(128 * 1024) }, '',
      { authorization: `Bearer ${worker.token}` })).status).toBe(413);
    expect((await http('/api/worker/poll', {}, '', { authorization: `Bearer ${worker.token}`, 'content-type': 'text/plain' })).status).toBe(415);
    await db.update(rateLimit).set({ count: 120 }).where(eq(rateLimit.key, `private-worker:${worker.workerId}`));
    const limited = await poll(worker.token);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBe('60');
    const before = (await db.select().from(rateLimit)).length;
    for (let i = 0; i < 3; i++) expect((await poll(randomBytes(32).toString('base64url'))).status).toBe(401);
    expect((await db.select().from(rateLimit)).length).toBe(before);
    vi.spyOn(auth, 'handler').mockResolvedValueOnce(Response.json({ error: 'Rate limited.' },
      { status: 429, headers: { 'Retry-After': '37' } }));
    const authLimited = await http('/api/workers', undefined, alice.cookie);
    expect(authLimited.status).toBe(429);
    expect(authLimited.headers.get('retry-after')).toBe('37');
    expect(await authLimited.json()).toMatchObject({ code: 'RATE_LIMITED' });
  });
  it('times out an unending JSON body and does not pair from a URL or revoke on a forged session', async () => {
    const input = new Request(`${origin}/api/worker/pair`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')); } }),
      duplex: 'half',
    } as RequestInit);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = pairRoute(input);
    await vi.advanceTimersByTimeAsync(8_100);
    const response = await pending;
    expect(response.status).toBe(408);
    vi.useRealTimers();
    const badPath = await pairRoute(new Request(`${origin}/api/worker/pair?grant=forbidden`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }));
    expect(badPath.status).toBe(400);
    expect((await http('/api/workers', undefined, `${alice.cookie}invalid`)).status).toBe(401);
  });
});
