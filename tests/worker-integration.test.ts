import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as authModule from '../lib/auth.ts';
import * as dbModule from '../lib/private-db/index.ts';
import { handleAuthRequest } from '../lib/auth-http.ts';
import type { AuthMail } from '../lib/auth-mail.ts';
import { applicationEvents, applicationRuns, applications, user, workers, workerPairings } from '../lib/private-db/schema.ts';
import { createEmptyProfile } from '../lib/applications/profile.ts';
import { createEmptyPolicy, type PolicyResponse } from '../lib/applications/policy.ts';
import { enqueueApplication } from '../lib/applications/runs.ts';
import * as p from '../lib/applications/worker-protocol.ts';
import { PATCH as saveProfileRoute } from '../app/api/profile/route.ts';
import { PATCH as savePolicyRoute, POST as enablePolicyRoute } from '../app/api/auto-apply/policies/route.ts';
import { POST as createPairingRoute } from '../app/api/workers/pairings/route.ts';
import { GET as listWorkersRoute } from '../app/api/workers/route.ts';
import { DELETE as revokeRoute } from '../app/api/workers/[id]/route.ts';
import { POST as pairRoute } from '../app/api/worker/pair/route.ts';
import { POST as pollRoute } from '../app/api/worker/poll/route.ts';
import { POST as heartbeatRoute } from '../app/api/worker/heartbeat/route.ts';
import { POST as eventRoute } from '../app/api/worker/applications/[id]/events/route.ts';
import { POST as createRunRoute } from '../app/api/application-runs/route.ts';
import { credentials, type CredentialBackend } from '../worker/credentials.ts';
import { pairWorker, WorkerCredentialSchema } from '../worker/pairing.ts';
import { privateStore } from '../worker/storage.ts';
import { workerTransport } from '../worker/transport.ts';
import { runWorker } from '../worker/runtime.ts';

vi.mock('server-only', () => ({}));
type Applicant = { id: string; cookie: string; email: string };
type Exchange = { path: string; body: string; status: number; response: unknown };
let dir: string, origin: string, server: Server, db: dbModule.PrivateDb, auth: authModule.ApplicantAuth;
let alice: Applicant, bob: Applicant, mail: AuthMail[], scheduled: (() => Promise<void>)[];
let exchanges: Exchange[], drops: Map<string, number>, serverErrors: unknown[], controllers: AbortController[];
const nativeFetch = globalThis.fetch;
const fresh = (expectedRevision = 0) => ({ requestId: randomUUID(), expectedRevision });
const eventPath = (id: string) => `/api/worker/applications/${id}/events`;
const clock = () => ({ mono: 0, wall: 0 });
const routes: Record<string, (request: Request) => Promise<Response>> = {
  'PATCH /api/profile': saveProfileRoute,
  'PATCH /api/auto-apply/policies': savePolicyRoute,
  'POST /api/auto-apply/policies': enablePolicyRoute,
  'POST /api/workers/pairings': createPairingRoute,
  'GET /api/workers': listWorkersRoute,
  'POST /api/worker/pair': pairRoute,
  'POST /api/worker/poll': pollRoute,
  'POST /api/worker/heartbeat': heartbeatRoute,
  'POST /api/application-runs': createRunRoute,
};
async function http(path: string, body?: unknown, owner?: Applicant, method = body === undefined ? 'GET' : 'POST') {
  return fetch(`${origin}${path}`, {
    method, redirect: 'manual', headers: {
      origin, ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(owner ? { cookie: owner.cookie, 'x-workie-applicant': owner.id } : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body),
  });
}
async function enroll(email: string): Promise<Applicant> {
  const password = 'synthetic-integration-password-123';
  expect((await http('/api/auth/sign-up/email', { email, password, name: 'Synthetic applicant' })).status).toBe(200);
  while (scheduled.length) await scheduled.shift()!();
  const link = mail.findLast(entry => entry.kind === 'verification' && entry.to === email)!.url;
  expect((await fetch(link, { redirect: 'manual' })).status).toBe(302);
  const response = await http('/api/auth/sign-in/email', { email, password });
  expect(response.status).toBe(200);
  const cookie = response.headers.getSetCookie().find(entry => entry.startsWith('workie.session_token='))!.split(';')[0];
  const [owner] = await db.select().from(user).where(eq(user.email, email));
  return { id: owner.id, cookie, email };
}
async function workerFor(owner: Applicant) {
  const response = await http('/api/workers/pairings', { ...fresh(), label: 'Synthetic integration host' }, owner);
  expect(response.status).toBe(200);
  const grant = p.PairingGrantSchema.parse(await response.json());
  expect(grant.ownerId).toBe(owner.id);
  const scope = { origin, ownerId: owner.id, workerId: randomUUID() };
  const store = await privateStore(join(dir, scope.workerId), scope);
  const secrets = new Map<string, string>();
  const backend: CredentialBackend = (service, account) => {
    const key = JSON.stringify([service, account]);
    return { getPassword: () => secrets.get(key) ?? null, setPassword: value => { secrets.set(key, value); },
      deletePassword: () => secrets.delete(key) };
  };
  const vault = credentials(scope, backend);
  const registration = workerTransport({ origin, allowLoopback: true });
  const readGrant = vi.fn(async () => grant.grant);
  const pair = () => pairWorker({ scope, store, vault, transport: registration, readGrant });
  const transport = () => workerTransport({
    origin, allowLoopback: true, token: WorkerCredentialSchema.parse(JSON.parse(vault.get('worker')!)).workerToken,
  });
  return { scope, store, vault, grant, readGrant, pair, transport, registration };
}
async function running(owner: Applicant, workerId: string) {
  const profile = createEmptyProfile();
  for (const [field, value] of [
    ['legalFirstName', 'Synthetic'], ['legalLastName', 'Applicant'], ['personalEmail', owner.email],
  ] as const) {
    Object.assign(profile.identity[field], { value, state: 'confirmed', confirmedAt: new Date().toISOString() });
  }
  expect((await http('/api/profile', { ...fresh(), profile }, owner, 'PATCH')).status).toBe(200);
  const policy = { ...createEmptyPolicy(), actions: ['read_jobs'], destinations: ['careers.example.test'], countries: ['US'] };
  const savedResponse = await http('/api/auto-apply/policies', { ...fresh(), policy }, owner, 'PATCH');
  expect(savedResponse.status).toBe(200);
  const saved: PolicyResponse = await savedResponse.json();
  const enabledResponse = await http('/api/auto-apply/policies', {
    ...fresh(saved.revision), action: 'enable', acceptedPolicyHash: saved.policyHash,
  }, owner);
  expect(enabledResponse.status).toBe(200);
  const enabled: PolicyResponse = await enabledResponse.json();
  expect(enabled).toMatchObject({ enabled: true, revision: saved.revision + 1 });
  const created = await http('/api/application-runs', { ...fresh(), workerId }, owner);
  expect(created.status).toBe(200);
  return { run: p.RunSchema.parse(await created.json()), policyRevision: enabled.revision };
}
function controller() {
  const value = new AbortController();
  controllers.push(value);
  return value;
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workie-worker-integration-'));
  vi.stubEnv('WORKIE_DB', join(dir, 'corpus-unused.db'));
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  db = dbModule.openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await dbModule.migratePrivateDb(db);
  mail = []; scheduled = []; exchanges = []; drops = new Map(); serverErrors = []; controllers = [];
  server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      }
      const request = new Request(`${origin}${req.url}`, {
        method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method!) ? undefined : body,
      });
      const path = new URL(request.url).pathname;
      const event = path.match(/^\/api\/worker\/applications\/([^/]+)\/events$/);
      const revoke = path.match(/^\/api\/workers\/([^/]+)$/);
      let response: Response;
      if (path.startsWith('/api/auth/')) response = await handleAuthRequest(request, () => auth);
      else if (event && req.method === 'POST') response = await eventRoute(request, { params: Promise.resolve({ id: event[1] }) });
      else if (revoke && req.method === 'DELETE') response = await revokeRoute(request, { params: Promise.resolve({ id: revoke[1] }) });
      else response = await routes[`${req.method} ${path}`]?.(request) ?? new Response(null, { status: 404 });
      const bytes = Buffer.from(await response.arrayBuffer());
      if (path.startsWith('/api/worker/')) {
        exchanges.push({ path, body: body.toString(), status: response.status, response: JSON.parse(bytes.toString()) });
      }
      // Drop only the response: the published handler already committed its real transaction.
      if (response.ok && (drops.get(path) ?? 0) > 0) {
        drops.set(path, drops.get(path)! - 1);
        res.destroy();
        return;
      }
      res.statusCode = response.status;
      for (const [key, value] of response.headers) if (key !== 'set-cookie') res.setHeader(key, value);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader('set-cookie', cookies);
      res.end(bytes);
    } catch (error) { serverErrors.push(error); res.writeHead(500).end('Synthetic fixture error'); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No loopback port');
  origin = `http://127.0.0.1:${address.port}`;
  vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
    if (new URL(url instanceof Request ? url.url : url).origin !== origin) throw new Error('External network forbidden.');
    return nativeFetch(url, init);
  });
  auth = authModule.createAuth({
    baseURL: origin, secret: randomBytes(32).toString('hex'),
    mailFrom: 'auth@example.test', allowedEmails: ['alice@example.test', 'bob@example.test'],
  }, db, { sendMail: async message => { mail.push(message); }, scheduleMail: task => { scheduled.push(task); } });
  vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
  vi.spyOn(dbModule, 'getPrivateDb').mockReturnValue(db);
  alice = await enroll('alice@example.test');
  bob = await enroll('bob@example.test');
});
afterEach(async () => {
  for (const value of controllers ?? []) value.abort();
  server?.closeAllConnections();
  if (server) await new Promise<void>(resolve => server.close(() => resolve()));
  db?.$client.close();
  const corpusCreated = dir && existsSync(join(dir, 'corpus-unused.db'));
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  expect(serverErrors).toEqual([]);
  expect(corpusCreated).toBe(false);
});

it('real handlers + transport/runtime recover exact registration/events and release the unsupported slot for next work', async () => {
  const worker = await workerFor(alice);
  drops.set('/api/worker/pair', 1);
  await expect(worker.pair()).rejects.toThrow('NETWORK_UNAVAILABLE');
  expect(await worker.store.read('pairing')).toMatchObject({ status: 'pending' });
  expect(await db.select().from(workers)).toHaveLength(1);
  await worker.pair();
  expect(worker.readGrant).toHaveBeenCalledOnce();
  const registrations = exchanges.filter(exchange => exchange.path === '/api/worker/pair');
  expect(registrations).toHaveLength(2);
  expect(registrations[1].body).toBe(registrations[0].body);
  expect(await db.select().from(workers)).toHaveLength(1);
  const [pairing] = await db.select().from(workerPairings);
  expect(pairing).toMatchObject({ id: worker.grant.pairingId, revision: 2, consumedAt: expect.any(Number) });
  expect(WorkerCredentialSchema.parse(JSON.parse(worker.vault.get('worker')!)).grant).toBeUndefined();
  const registration = p.PairRequestSchema.parse(JSON.parse(registrations[0].body));
  const metadata = JSON.stringify(await worker.store.read('pairing'));
  expect(metadata).not.toContain(registration.workerToken);
  expect(metadata).not.toContain(registration.grant);
  await expect(worker.registration.pair({ ...registration, requestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
  const { run, policyRevision } = await running(alice, worker.scope.workerId);
  const identity = { ats: 'fixture', tenant: 'synthetic', requisition: 'first' };
  const queuedAt = Date.now() - 1;
  const first = await enqueueApplication(db, alice.id, run.id, identity, { now: () => queuedAt });
  expect((await enqueueApplication(db, alice.id, run.id, identity)).id).toBe(first.id);
  const second = await enqueueApplication(db, alice.id, run.id, { ...identity, requisition: 'second' }, { now: () => queuedAt + 1 });
  drops.set(eventPath(first.id), 3);
  const transport = worker.transport();
  await expect(runWorker({ scope: worker.scope, store: worker.store, transport, clock, signal: controller().signal }))
    .rejects.toThrow('NETWORK_UNAVAILABLE');
  const attempts = exchanges.filter(exchange => exchange.path === eventPath(first.id));
  expect(attempts).toHaveLength(3);
  expect(new Set(attempts.map(exchange => exchange.body)).size).toBe(1);
  const event = p.EventRequestSchema.parse(JSON.parse(attempts[0].body));
  expect(event).toMatchObject({ state: 'blocked_unsupported', reasonCode: 'adapter_unavailable', checkpoint: { stage: 'screening', sequence: 1 } });
  expect(attempts.map(exchange => p.EventResponseSchema.parse(exchange.response).replayed)).toEqual([false, true, true]);
  expect(await worker.store.read('checkpoint')).toMatchObject({ pending: { applicationId: first.id, event }, acknowledged: null });
  const [blocked] = await db.select().from(applications).where(eq(applications.id, first.id));
  expect(blocked).toMatchObject({ state: 'blocked_unsupported', leaseUntil: null, revision: event.expectedRevision + 1 });
  expect(await db.select().from(applicationEvents)).toHaveLength(1);
  expect(await worker.store.read('lock')).toBeNull();
  const restartAt = exchanges.length, stop = controller();
  await runWorker({ scope: worker.scope, store: worker.store, transport, clock, signal: stop.signal,
    status: status => { if (status === 'waiting') stop.abort(); } });
  const restarted = exchanges.slice(restartAt);
  expect(restarted.map(exchange => exchange.path)).toEqual([eventPath(first.id), '/api/worker/poll', eventPath(second.id)]);
  expect(restarted[0].body).toBe(attempts[0].body);
  expect(p.EventResponseSchema.parse(restarted[0].response)).toMatchObject({ replayed: true, lease: null });
  expect(p.PollResponseSchema.parse(restarted[1].response).lease).toMatchObject({
    applicationId: second.id, ownerId: alice.id, workerId: worker.scope.workerId, policyRevision,
  });
  expect(await db.select().from(applications).where(eq(applications.id, first.id))).toEqual([blocked]);
  const [next] = await db.select().from(applications).where(eq(applications.id, second.id));
  expect(next).toMatchObject({ state: 'blocked_unsupported', reasonCode: 'adapter_unavailable', leaseUntil: null });
  expect(await db.select().from(applicationEvents)).toHaveLength(2);
  expect(await worker.store.read('checkpoint')).toMatchObject({
    pending: null, acknowledged: { applicationId: second.id, state: 'blocked_unsupported', lease: null },
  });
  expect(await worker.store.read('lock')).toBeNull();
  await expect(transport.event(first.id, { ...event, reasonCode: 'changed_retry' })).rejects.toMatchObject({ status: 409 });
  expect((await transport.poll()).lease).toBeNull();
  expect((await db.select().from(applications)).every(app => app.state === 'blocked_unsupported')).toBe(true);
  expect(p.WorkerListSchema.parse(await (await http('/api/workers', undefined, bob)).json()).workers).toEqual([]);
});

it('real owner binding, rotating fences and revoke stop the runtime without affecting the other applicant', async () => {
  const a = await workerFor(alice), b = await workerFor(bob);
  await a.pair(); await b.pair();
  const ar = await running(alice, a.scope.workerId), br = await running(bob, b.scope.workerId);
  const identity = { ats: 'fixture', tenant: 'same-tenant', requisition: 'same-role' };
  const aa = await enqueueApplication(db, alice.id, ar.run.id, identity);
  const ba = await enqueueApplication(db, bob.id, br.run.id, identity);
  expect(aa.id).not.toBe(ba.id);
  const at = a.transport(), bt = b.transport();
  const stale = (await at.poll()).lease!;
  const other = (await bt.poll()).lease!;
  expect(stale).toMatchObject({ applicationId: aa.id, ownerId: alice.id, policyRevision: ar.policyRevision });
  expect(other).toMatchObject({ applicationId: ba.id, ownerId: bob.id, policyRevision: br.policyRevision });
  const ref = { applicationId: stale.applicationId, fence: stale.fence, expectedRevision: stale.revision };
  const event = p.EventRequestSchema.parse({
    protocolVersion: p.WORKER_PROTOCOL_VERSION, eventId: randomUUID(), fence: stale.fence,
    expectedRevision: stale.revision, state: 'blocked_unsupported',
    checkpoint: { stage: 'screening', sequence: 1 }, reasonCode: 'adapter_unavailable',
  });
  await expect(bt.event(aa.id, event)).rejects.toMatchObject({ status: 404 });
  await expect(bt.heartbeat(ref)).rejects.toMatchObject({ status: 409 });
  const wrongScope = { ...a.scope, ownerId: bob.id };
  const wrongStore = await privateStore(join(dir, 'wrong-owner'), wrongScope);
  await expect(runWorker({ scope: wrongScope, store: wrongStore, transport: at, clock, signal: controller().signal }))
    .rejects.toThrow('BINDING_CHANGED');
  expect(await wrongStore.read('checkpoint')).toBeNull();
  expect(await wrongStore.read('lock')).toBeNull();
  const renewed = (await at.poll()).lease!;
  expect(renewed.fence).toBeGreaterThan(stale.fence);
  expect((await at.heartbeat({
    applicationId: renewed.applicationId, fence: renewed.fence, expectedRevision: renewed.revision,
  })).lease).toMatchObject({ applicationId: aa.id, fence: renewed.fence, revision: renewed.revision });
  await expect(at.event(aa.id, event)).rejects.toMatchObject({ status: 409 });
  await expect(at.heartbeat(ref)).rejects.toMatchObject({ status: 409 });
  expect(await db.select().from(applicationEvents)).toEqual([]);
  const revokePath = `/api/workers/${a.scope.workerId}`;
  expect((await http(revokePath, fresh(1), bob, 'DELETE')).status).toBe(404);
  expect((await http(revokePath, fresh(1), { ...bob, id: alice.id }, 'DELETE')).status).toBe(403);
  const revoked = await http(revokePath, fresh(1), alice, 'DELETE');
  expect(revoked.status).toBe(200);
  expect(p.RevocationSchema.parse(await revoked.json())).toMatchObject({ id: a.scope.workerId, revision: 2 });
  await expect(runWorker({ scope: a.scope, store: a.store, transport: at, clock, signal: controller().signal }))
    .rejects.toMatchObject({ status: 401 });
  await expect(at.heartbeat(ref)).rejects.toMatchObject({ status: 401 });
  await expect(at.event(aa.id, event)).rejects.toMatchObject({ status: 401 });
  expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, ar.run.id)))[0].state).toBe('paused');
  expect((await db.select().from(applications).where(eq(applications.id, aa.id)))[0]).toMatchObject({
    leaseUntil: null, reasonCode: 'worker_revoked', fence: renewed.fence + 1,
  });
  expect((await bt.heartbeat({
    applicationId: other.applicationId, fence: other.fence, expectedRevision: other.revision,
  })).lease).toMatchObject({ applicationId: ba.id, ownerId: bob.id, fence: other.fence });
  expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, br.run.id)))[0].state).toBe('running');
  expect(await db.select().from(applicationEvents)).toEqual([]);
  expect(await a.store.read('lock')).toBeNull();
});

it('real runtime defers unknown on its next poll and progresses another tenant without mutable reconciliation', async () => {
  const worker = await workerFor(alice);
  await worker.pair();
  const { run } = await running(alice, worker.scope.workerId);
  const queuedAt = Date.now() - 1;
  const unknown = await enqueueApplication(db, alice.id, run.id,
    { ats: 'fixture', tenant: 'unknown-tenant', requisition: 'unknown' }, { now: () => queuedAt });
  // Persisted ambiguous submission is fault injection only, not a submit execution path.
  await db.update(applications).set({ state: 'submission_unknown' }).where(eq(applications.id, unknown.id));
  const next = await enqueueApplication(db, alice.id, run.id,
    { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, { now: () => queuedAt + 1 });
  const statuses: string[] = [], stop = controller(), transport = worker.transport();
  const deadline = setTimeout(() => stop.abort(), 25_000);
  try {
    await runWorker({ scope: worker.scope, store: worker.store, transport, clock, signal: stop.signal,
      status: status => {
        statuses.push(status);
        if (status === 'waiting' || statuses.filter(value => value === 'reconciliation-required').length > 1) stop.abort();
      } });
  } finally { clearTimeout(deadline); }
  expect(statuses.filter(value => value === 'reconciliation-required')).toHaveLength(1);
  expect(statuses).toContain('waiting');
  const polls = exchanges.filter(exchange => exchange.path === '/api/worker/poll')
    .map(exchange => p.PollResponseSchema.parse(exchange.response));
  expect(polls.map(response => response.lease?.applicationId)).toEqual([unknown.id, next.id]);
  const lease = polls[0].lease!;
  expect(lease).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
  expect(exchanges.filter(exchange => exchange.path === eventPath(unknown.id))).toEqual([]);
  expect((await db.select().from(applicationEvents)).map(event => event.applicationId)).toEqual([next.id]);
  const [deferred] = await db.select().from(applications).where(eq(applications.id, unknown.id));
  expect(deferred).toMatchObject({ state: 'submission_unknown', leaseUntil: null, leaseCheckedAt: null,
    retries: 0, checkpoint: null, fence: lease.fence + 1, revision: lease.revision + 1,
    reasonCode: 'reconciliation_deferred' });
  expect(deferred.availableAt).toBeGreaterThan(polls[1].serverTime + p.HEARTBEAT_MS);
  expect((await db.select().from(applications).where(eq(applications.id, next.id)))[0])
    .toMatchObject({ state: 'blocked_unsupported', reasonCode: 'adapter_unavailable', leaseUntil: null });
  await expect(transport.heartbeat({ applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision }))
    .rejects.toMatchObject({ status: 409 });
  expect((await transport.poll()).lease).toBeNull();
  expect(await worker.store.read('checkpoint')).toMatchObject({
    pending: null, acknowledged: { applicationId: next.id, state: 'blocked_unsupported', lease: null },
  });
  expect(await worker.store.read('lock')).toBeNull();
}, 30_000);
