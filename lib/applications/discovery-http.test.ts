import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as authModule from '../auth.ts';
import * as privateDb from '../private-db/index.ts';
import { user, policyHeads, policyVersions, discoveryManifests, manualApplicationMarks } from '../private-db/schema.ts';
import { openDb, type Db } from '../db/index.ts';
import { postings } from '../db/schema.ts';
import * as corpusModule from './discovery-corpus.ts';
import { createEmptyPolicy } from './policy.ts';
import { hashValue } from './stores.ts';
import { createPairing, pairWorker } from './pairing.ts';
import { createRun } from './runs.ts';
import { ImportPreviewSchema, ImportAcknowledgementSchema, DiscoveryStatusSchema } from './discovery-protocol.ts';
import { POST as previewRoute } from '../../app/api/applications/import/preview/route.ts';
import { POST as confirmRoute } from '../../app/api/applications/import/confirm/route.ts';
import { GET as statusRoute, POST as abandonRoute } from '../../app/api/application-runs/[id]/discovery/route.ts';
import { POST as reapplyRoute } from '../../app/api/application-runs/[id]/reapply/route.ts';
import { POST as pollRoute } from '../../app/api/worker/poll/route.ts';

vi.mock('server-only', () => ({}));
const origin = 'http://127.0.0.1:3101';
let db: privateDb.PrivateDb, corpus: Db, dir: string, auth: authModule.ApplicantAuth;
let alice: { id: string; cookie: string }, bob: { id: string; cookie: string };
const fresh = () => ({ requestId: randomUUID() });
const password = 'synthetic-discovery-password-only-123';
function req(path: string, input?: unknown, owner = alice, headers: Record<string, string> = {}) {
  return new Request(`${origin}${path}`, {
    method: input === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: owner.cookie, 'x-workie-applicant': owner.id, ...headers },
    body: input === undefined ? undefined : JSON.stringify(input),
  });
}
async function enroll(email: string) {
  const response = await auth.handler(new Request(`${origin}/api/auth/sign-up/email`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, name: 'Synthetic', password }) }));
  expect(response.status).toBe(200);
  await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
  const signed = await auth.handler(new Request(`${origin}/api/auth/sign-in/email`, { method: 'POST',
    headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) }));
  expect(signed.status).toBe(200);
  const cookie = signed.headers.getSetCookie().find((entry) => entry.startsWith('workie.session_token='))!.split(';')[0];
  return { id: (await db.select().from(user).where(eq(user.email, email)))[0].id, cookie };
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase4-http-'));
  vi.stubEnv('WORKIE_DB', join(dir, 'forbidden-default.db'));
  vi.stubEnv('TURSO_DATABASE_URL', '');
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden'); }));
  db = privateDb.openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await privateDb.migratePrivateDb(db);
  corpus = openDb(join(dir, 'fixture.db'), { migrate: true });
  corpus.insert(postings).values({
    id: 1, dedupeKey: 'synthetic', canonicalUrl: 'https://boards.greenhouse.io/fixture/jobs/123',
    company: 'Fixture', title: 'Engineer', firstSeenRun: 'fixture', postedAt: new Date(), companyNorm: 'fixture',
    titleNorm: 'engineer', locationKey: 'US', country: 'US', track: 'engineering', paid: true,
  }).run();
  auth = authModule.createAuth({ baseURL: origin, secret: randomBytes(32).toString('hex'), mailFrom: 'auth@example.test',
    allowedEmails: ['alice@example.test', 'bob@example.test'] }, db, { sendMail: async () => {}, scheduleMail: () => {} });
  vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
  vi.spyOn(privateDb, 'getPrivateDb').mockReturnValue(db);
  alice = await enroll('alice@example.test'); bob = await enroll('bob@example.test');
});
afterEach(() => {
  (corpus as Db & { $client: Database.Database })?.$client.close();
  db?.$client.close();
  const forbiddenCreated = dir && existsSync(join(dir, 'forbidden-default.db'));
  if (dir) rmSync(dir, { force: true, recursive: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers();
  expect(forbiddenCreated).toBe(false);
});

it('authenticates before any corpus access; denies malicious authority, IDs, bodies, origins and paths with no-store responses', async () => {
  const corpusRead = vi.spyOn(corpusModule, 'getDiscoveryCorpus').mockReturnValue(corpus);
  const input = { ...fresh(), postingIds: [1] };
  for (const [headers, status] of [
    [{ cookie: '' }, 401],
    [{ 'x-workie-applicant': bob.id }, 403],
    [{ origin: 'https://evil.example.test' }, 403],
    [{ 'sec-fetch-site': 'cross-site' }, 403],
  ] as [Record<string, string>, number][]) {
    const response = await previewRoute(req('/api/applications/import/preview', input, alice, headers));
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  }
  for (const body of [
    { ...input, ownerId: bob.id }, { ...input, postingIds: [1, 1] }, { ...input, postingIds: [1.1] },
    { ...input, postingIds: ['1 OR 1=1'] }, { ...input, postingIds: [Number.MAX_SAFE_INTEGER + 1] },
  ]) expect((await previewRoute(req('/api/applications/import/preview', body))).status).toBe(400);
  expect((await previewRoute(req('/api/applications/import/preview?owner=bob', input))).status).toBe(400);
  expect((await previewRoute(req('/api/applications/import/preview', input, alice, { 'content-type': 'text/plain' }))).status).toBe(415);
  expect((await previewRoute(req('/api/applications/import/preview', { ...input, padding: 'x'.repeat(128 * 1024) }))).status).toBe(413);
  expect(corpusRead).not.toHaveBeenCalled();
});

it('returns shared DTOs, immutable preview retries and explicit expiry/conflict codes without reading corpus on confirmation', async () => {
  const corpusRead = vi.spyOn(corpusModule, 'getDiscoveryCorpus').mockReturnValue(corpus);
  const input = { ...fresh(), postingIds: [1, 777] };
  const p = ImportPreviewSchema.parse(await (await previewRoute(req('/api/applications/import/preview', input))).json());
  expect(p.ownerId).toBe(alice.id);
  expect(ImportPreviewSchema.parse(await (await previewRoute(req('/api/applications/import/preview', input))).json())).toEqual(p);
  expect(corpusRead).toHaveBeenCalledTimes(1);
  const command = { ...fresh(), previewToken: p.previewToken, previewHash: p.previewHash, postingIds: [1, 777], confirmOwnership: true };
  expect((await confirmRoute(req('/api/applications/import/confirm', command, bob))).status).toBe(404);
  const changed = await confirmRoute(req('/api/applications/import/confirm', { ...command, previewHash: '0'.repeat(64) }));
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ code: 'CONFLICT' });
  const ack = ImportAcknowledgementSchema.parse(await (await confirmRoute(req('/api/applications/import/confirm', command))).json());
  expect(ack).toMatchObject({ ownerId: alice.id, resolvedCount: 1, unresolvedCount: 1, status: 'manual_reported' });
  expect(await (await confirmRoute(req('/api/applications/import/confirm', command))).json()).toEqual(ack);
  const next = ImportPreviewSchema.parse(await (await previewRoute(req('/api/applications/import/preview', { ...fresh(), postingIds: [1] }))).json());
  vi.spyOn(Date, 'now').mockReturnValue(next.expiresAt);
  const expired = await confirmRoute(req('/api/applications/import/confirm', { ...command, ...fresh(), previewToken: next.previewToken,
    previewHash: next.previewHash, postingIds: [1] }));
  expect(expired.status).toBe(409);
  expect(await expired.json()).toMatchObject({ code: 'PREVIEW_EXPIRED' });
  expect(corpusRead).toHaveBeenCalledTimes(2);
  expect(await db.select().from(manualApplicationMarks)).toHaveLength(2);
});

it('uses the authenticated existing worker poll for discovery, validates tenant scope on status and preserves worker v1', async () => {
  const corpusRead = vi.spyOn(corpusModule, 'getDiscoveryCorpus').mockReturnValue(corpus);
  const policy = { ...createEmptyPolicy(), actions: ['read_jobs'] as const, undisclosedPay: 'include' as const }, hash = hashValue(policy), now = Date.now();
  await db.insert(policyVersions).values({ ownerId: alice.id, version: 1, policy: { ...policy, actions: ['read_jobs'] }, hash, createdAt: now });
  await db.insert(policyHeads).values({ ownerId: alice.id, revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  const options = { isAllowedApplicant: auth.isAllowedApplicant };
  const grant = await createPairing(db, alice.id, { ...fresh(), expectedRevision: 0, label: 'Synthetic' }, options);
  const token = randomBytes(32).toString('base64url');
  const worker = await pairWorker(db, { ...fresh(), protocolVersion: 1, workerId: randomUUID(), grant: grant.grant,
    workerToken: token, workerVersion: '0.1', capabilities: ['control-v1'] }, options);
  const run = await createRun(db, alice.id, { ...fresh(), expectedRevision: 0, workerId: worker.workerId }, options);
  const poll = (credential: string) => pollRoute(req('/api/worker/poll', { protocolVersion: 1 }, alice, { authorization: `Bearer ${credential}` }));
  expect((await poll(randomBytes(32).toString('base64url'))).status).toBe(401);
  expect(corpusRead).not.toHaveBeenCalled();
  const response = await poll(token);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ protocolVersion: 1, lease: { ats: 'greenhouse', requisition: '123' } });
  expect(corpusRead).toHaveBeenCalledTimes(1);
  const context = { params: Promise.resolve({ id: run.id }) };
  const status = await statusRoute(req(`/api/application-runs/${run.id}/discovery`), context);
  expect(DiscoveryStatusSchema.parse(await status.json())).toMatchObject({ ownerId: alice.id, state: 'ready', candidateCount: 1 });
  expect((await statusRoute(req(`/api/application-runs/${run.id}/discovery`, undefined, bob), context)).status).toBe(404);
  expect((await statusRoute(req('/api/application-runs/bad/discovery'), { params: Promise.resolve({ id: 'bad' }) })).status).toBe(400);
  const [manifest] = await db.select().from(discoveryManifests);
  expect((await abandonRoute(req(`/api/application-runs/${run.id}/discovery`, { ...fresh(), manifestId: manifest.id }, bob), context)).status).toBe(404);
  expect((await reapplyRoute(req(`/api/application-runs/${run.id}/reapply`, { ...fresh(), previousApplicationId: randomUUID(), expectedRevision: 1 }, bob), context)).status).toBe(404);
});

it('opens only an existing local read-only corpus, never creating or migrating the configured file', async () => {
  expect(() => corpusModule.getDiscoveryCorpus()).toThrow();
  expect(existsSync(join(dir, 'forbidden-default.db'))).toBe(false);
  vi.stubEnv('WORKIE_DB', join(dir, 'fixture.db'));
  const readonly = corpusModule.getDiscoveryCorpus() as Db & { $client: Database.Database };
  try {
    expect(readonly.select().from(postings).all()).toHaveLength(1);
    expect(() => readonly.delete(postings).run()).toThrow(/readonly/i);
    expect(corpusModule.getDiscoveryCorpus()).toBe(readonly);
  } finally { readonly.$client.close(); }
});
