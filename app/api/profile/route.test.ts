import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import * as authModule from '@/lib/auth';
import { createAuth } from '@/lib/auth';
import * as dbModule from '@/lib/private-db';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '@/lib/private-db';
import { user, session, rateLimit, profileHeads, profileVersions, policyHeads, policyVersions, policyCommands } from '@/lib/private-db/schema';
import { documents, documentUploadGrants } from '@/lib/private-db/document-schema';
import { createEmptyProfile } from '@/lib/applications/profile';
import { createEmptyPolicy } from '@/lib/applications/policy';
import { GET, PATCH } from './route';
import { GET as draftKey } from './draft-key/route';
import { GET as policyGet, PATCH as policyPatch, POST as policyPost } from '../auto-apply/policies/route';
import { POST as createDocument } from '../documents/route';
import { PUT as uploadDocument } from '../documents/uploads/[grantId]/route';
import { POST as validateDocument } from '../documents/[id]/validate/route';
import { POST as blobUpload } from '../documents/upload/route';
import { readPrivateJson } from '@/lib/applications/private-http';
import { writeDocumentObject } from '@/lib/applications/documents-storage';
import { z } from 'zod';

vi.mock('server-only', () => ({}));
let dir: string;
let db: PrivateDb;
let auth: ReturnType<typeof createAuth>;
let a: { cookie: string; ownerId: string };
let b: { cookie: string; ownerId: string };
const origin = 'https://workie.example.test';
function request(method = 'GET', body?: unknown, cookie = a?.cookie, path = '/api/profile',
  expectedOwner = cookie === a?.cookie ? a?.ownerId : cookie === b?.cookie ? b?.ownerId : undefined) {
  return new Request(`${origin}${path}`, {
    method, headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}),
      ...(expectedOwner ? { 'x-workie-applicant': expectedOwner } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
beforeEach(async () => {
  dir = mkdtempSync(join(process.cwd(), 'logs/auto-apply-gate/profile-http-'));
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('WORKIE_DB', join(dir, 'corpus.db')); vi.stubEnv('TURSO_DATABASE_URL', '');
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden.'); }));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  auth = createAuth({ baseURL: origin, secret: randomBytes(32).toString('hex'),
    allowedEmails: ['a@example.test', 'b@example.test'], mailFrom: 'auth@example.test' }, db,
  { sendMail: async () => { throw new Error('No SMTP in tests.'); }, scheduleMail: () => {} });
  vi.spyOn(authModule, 'getAuth').mockReturnValue(auth);
  vi.spyOn(dbModule, 'getPrivateDb').mockReturnValue(db);
  async function enroll(email: string) {
    const password = 'synthetic-password-123456';
    const response = await auth.handler(request('POST', { email, password, name: 'Synthetic' }, '', '/api/auth/sign-up/email'));
    expect(response.status).toBe(200);
    // Fixture verification only; production verification path is covered in auth.test.ts.
    await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));
    const login = await auth.handler(request('POST', { email, password }, '', '/api/auth/sign-in/email'));
    expect(login.status).toBe(200);
    const [row] = await db.select().from(user).where(eq(user.email, email));
    return { cookie: login.headers.getSetCookie().find((s) => s.startsWith('__Secure-workie.session_token='))!.split(';')[0], ownerId: row.id };
  }
  a = await enroll('a@example.test'); b = await enroll('b@example.test');
});
afterEach(() => {
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
});
function privateHeaders(response: Response) {
  expect(response.headers.get('cache-control')).toBe('private, no-store');
  expect(response.headers.get('cdn-cache-control')).toBe('no-store');
  expect(response.headers.get('vary')).toContain('Cookie');
}
it('round trips the actual profile handlers using two real sessions and ignores query owner forgery', async () => {
  const input = { expectedRevision: 0, requestId: crypto.randomUUID(), profile: createEmptyProfile() };
  const saved = await PATCH(request('PATCH', input));
  expect(saved.status).toBe(200); privateHeaders(saved);
  const acknowledgement = await saved.json();
  expect(acknowledgement).toMatchObject({ revision: 1, ownerId: a.ownerId });
  const other = await GET(request('GET', undefined, b.cookie, `/api/profile?ownerId=${a.ownerId}`));
  expect(await other.json()).toMatchObject({ revision: 0, ownerId: b.ownerId });
  const retry = await PATCH(request('PATCH', input));
  expect(await retry.json()).toEqual(acknowledgement);
  const conflict = await PATCH(request('PATCH', { ...input, requestId: crypto.randomUUID() }));
  expect(conflict.status).toBe(409); privateHeaders(conflict);
  const forged = await PATCH(request('PATCH', { ...input, ownerId: b.ownerId }));
  expect(forged.status).toBe(400);
  const omitted = { ...input, profile: { ...input.profile, identity: { ...input.profile.identity, preferredName: undefined } } };
  expect((await PATCH(request('PATCH', omitted))).status).toBe(400);
  expect((await PATCH(request('PATCH', omitted))).status).toBe(400);
});
it('rejects A drafts with B cookies at equal head revisions before any profile or policy write', async () => {
  const profile = createEmptyProfile();
  for (const account of [a, b]) {
    expect((await PATCH(request('PATCH', { expectedRevision: 0, requestId: crypto.randomUUID(), profile }, account.cookie))).status).toBe(200);
    expect((await policyPatch(request('PATCH', {
      expectedRevision: 0, requestId: crypto.randomUUID(), policy: createEmptyPolicy(),
    }, account.cookie))).status).toBe(200);
  }
  const draft = await (await GET(request())).json();
  expect(draft.revision).toBe((await (await GET(request('GET', undefined, b.cookie))).json()).revision);
  draft.profile.identity.preferredName = { ...draft.profile.identity.preferredName,
    state: 'confirmed', value: 'Private A draft', confirmedAt: new Date().toISOString() };
  const profileInput = { expectedRevision: draft.revision, requestId: crypto.randomUUID(), profile: draft.profile };
  const policyInput = { expectedRevision: 1, requestId: crypto.randomUUID(), policy: createEmptyPolicy() };
  const snapshot = async () => ({
    profiles: await db.select().from(profileVersions), profileHeads: await db.select().from(profileHeads),
    policies: await db.select().from(policyVersions), policyHeads: await db.select().from(policyHeads),
    commands: await db.select().from(policyCommands),
    // Authoritative auth lookups still count; rejected drafts must not reach the write limiter.
    limits: await db.select().from(rateLimit).where(inArray(rateLimit.key, [a, b].map(({ ownerId }) => `private-applicant:${ownerId}`))),
  });
  const before = await snapshot();
  for (const [handler, method, body] of [
    [PATCH, 'PATCH', profileInput], [policyPatch, 'PATCH', policyInput],
    [policyPost, 'POST', { expectedRevision: 1, requestId: crypto.randomUUID(), action: 'disable' }],
    [policyPost, 'POST', { expectedRevision: 1, requestId: crypto.randomUUID(), action: 'enable', acceptedPolicyHash: 'a'.repeat(64) }],
  ] as const) {
    for (const missing of [false, true]) {
      const switched = request(method, body, b.cookie, '/api/profile', a.ownerId);
      if (missing) switched.headers.delete('x-workie-applicant');
      const denied = await handler(switched);
      expect(denied.status).toBe(403); privateHeaders(denied);
      expect(await denied.json()).toEqual({ error: 'Applicant session changed. Unlock the current account.' });
      expect(switched.bodyUsed).toBe(false);
      expect(await snapshot()).toEqual(before);
    }
  }
  expect((await PATCH(request('PATCH', profileInput))).status).toBe(200);
  expect((await policyPatch(request('PATCH', policyInput))).status).toBe(200);
  expect((await (await GET(request('GET', undefined, b.cookie))).json()).revision).toBe(1);
  expect((await (await policyGet(request('GET', undefined, b.cookie))).json()).revision).toBe(1);
});
it('allows same-principal renewed tokens and rejects mismatched private reads before releasing data', async () => {
  const originalKey = await (await draftKey(request())).json();
  const login = await auth.handler(request('POST', {
    email: 'a@example.test', password: 'synthetic-password-123456',
  }, '', '/api/auth/sign-in/email'));
  expect(login.status).toBe(200);
  const renewedCookie = login.headers.getSetCookie().find((s) => s.startsWith('__Secure-workie.session_token='))!.split(';')[0];
  expect(renewedCookie).not.toBe(a.cookie);
  expect((await PATCH(request('PATCH', {
    expectedRevision: 0, requestId: crypto.randomUUID(), profile: createEmptyProfile(),
  }, renewedCookie, '/api/profile', a.ownerId))).status).toBe(200);
  expect((await policyPatch(request('PATCH', {
    expectedRevision: 0, requestId: crypto.randomUUID(), policy: createEmptyPolicy(),
  }, renewedCookie, '/api/auto-apply/policies', a.ownerId))).status).toBe(200);
  expect((await policyPost(request('POST', {
    expectedRevision: 1, requestId: crypto.randomUUID(), action: 'disable',
  }, renewedCookie, '/api/auto-apply/policies', a.ownerId))).status).toBe(200);
  expect(await (await draftKey(request('GET', undefined, renewedCookie, '/api/profile/draft-key', a.ownerId))).json()).toEqual(originalKey);
  for (const handler of [GET, policyGet, draftKey]) {
    const denied = await handler(request('GET', undefined, b.cookie, '/api/profile', a.ownerId));
    expect(denied.status).toBe(403); privateHeaders(denied);
    const initial = request();
    initial.headers.delete('x-workie-applicant');
    expect((await handler(initial)).status).toBe(200);
  }
});
it('binds actual document routes to real sessions and accepts same-user renewed cookies', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'workie-principal-doc-')));
  try {
    const login = await auth.handler(request('POST', {
      email: 'a@example.test', password: 'synthetic-password-123456',
    }, '', '/api/auth/sign-in/email'));
    expect(login.status).toBe(200);
    const renewed = login.headers.getSetCookie().find((s) => s.startsWith('__Secure-workie.session_token='))!.split(';')[0];
    expect(renewed).not.toBe(a.cookie);
    const pdf = await PDFDocument.create(); pdf.addPage();
    const bytes = await pdf.save();
    const snapshot = async () => ({
      documents: await db.select().from(documents).orderBy(documents.id),
      grants: await db.select().from(documentUploadGrants).orderBy(documentUploadGrants.id),
    });
    for (const mode of ['local', 'blob'] as const) {
      vi.stubEnv('WORKIE_DOCUMENT_STORAGE', mode);
      vi.stubEnv('WORKIE_DOCUMENT_DIRECTORY', directory);
      vi.stubEnv('VERCEL', mode === 'blob' ? '1' : '');
      vi.stubEnv('BLOB_READ_WRITE_TOKEN', 'vercel_blob_rw_synthetic_abcdefghijklmnopqrstuvwxyz123456');
      vi.stubEnv('WORKIE_DOCUMENT_BLOB_ORIGIN', 'https://synthetic.private.blob.vercel-storage.com');
      vi.stubEnv('WORKIE_DOCUMENT_CALLBACK_URL', `${origin}/api/documents/upload`);
      vi.stubEnv('BETTER_AUTH_URL', origin);
      const input = { requestId: crypto.randomUUID(), kind: 'resume_master', name: 'synthetic.pdf', mime: 'application/pdf', size: bytes.length };
      const other = await createDocument(request('POST', input, b.cookie, '/api/documents'));
      expect(other.status).toBe(201);
      const target = await other.json();
      const tokenBody = { type: 'blob.generate-client-token', payload: {
        pathname: target.pathname, clientPayload: JSON.stringify({ grantId: target.grantId }), multipart: false,
      } };
      const upload = (req: Request) => uploadDocument(req, { params: Promise.resolve({ grantId: target.grantId }) });
      const validate = (req: Request) => validateDocument(req, { params: Promise.resolve({ id: target.document.id }) });
      const actions = mode === 'local'
        ? [[createDocument, 'POST', input], [upload, 'PUT', null], [validate, 'POST', {}]] as const
        : [[createDocument, 'POST', input], [blobUpload, 'POST', tokenBody]] as const;
      const before = await snapshot();
      for (const [handler, method, body] of actions) {
        for (const missing of [false, true]) {
          const denied = request(method, body, b.cookie, '/api/documents', a.ownerId);
          if (missing) denied.headers.delete('x-workie-applicant');
          const response = await handler(denied);
          expect(response.status).toBe(403); privateHeaders(response);
          expect(denied.bodyUsed).toBe(false);
          expect(await snapshot()).toEqual(before);
        }
      }
      const granted = await createDocument(request('POST', { ...input, requestId: crypto.randomUUID() }, renewed, '/api/documents', a.ownerId));
      expect(granted.status).toBe(201);
      const own = await granted.json();
      if (mode === 'local') {
        const raw = new Request(`${origin}/api/documents/uploads/${own.grantId}`, { method: 'PUT',
          headers: { origin, cookie: renewed, 'x-workie-applicant': a.ownerId, 'content-type': 'application/pdf' }, body: Buffer.from(bytes) });
        expect((await uploadDocument(raw, { params: Promise.resolve({ grantId: own.grantId }) })).status).toBe(200);
        const pending = await createDocument(request('POST', { ...input, requestId: crypto.randomUUID() }, renewed, '/api/documents', a.ownerId));
        expect(pending.status).toBe(201);
        const retry = await pending.json();
        await writeDocumentObject({ mode: 'local', directory }, retry.pathname, bytes);
        await db.update(documents).set({ state: 'quarantined', safetyCheck: 'deferred' }).where(eq(documents.id, retry.document.id));
        expect((await validateDocument(request('POST', {}, renewed, '/api/documents', a.ownerId),
          { params: Promise.resolve({ id: retry.document.id }) })).status).toBe(200);
        expect((await db.select().from(documents).where(eq(documents.id, retry.document.id)))[0]).toMatchObject({
          ownerId: a.ownerId, state: 'available', attempts: 1,
        });
      } else {
        const token = await blobUpload(request('POST', { ...tokenBody, payload: {
          ...tokenBody.payload, pathname: own.pathname, clientPayload: JSON.stringify({ grantId: own.grantId }),
        } }, renewed, '/api/documents/upload', a.ownerId));
        expect(token.status).toBe(200);
        expect((await db.select().from(documentUploadGrants).where(eq(documentUploadGrants.id, own.grantId)))[0]).toMatchObject({
          ownerId: a.ownerId, tokenIssued: true,
        });
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
it('fails closed for absent/revoked sessions, cross-origin requests, and missing encryption configuration', async () => {
  const anonymous = await GET(request('GET', undefined, ''));
  expect(anonymous.status).toBe(401); privateHeaders(anonymous);
  expect((await GET(request('GET', undefined, '', '/api/profile', a.ownerId))).status).toBe(401);
  expect((await PATCH(request('PATCH', {}, '', '/api/profile', a.ownerId))).status).toBe(401);
  const req = request('PATCH', { expectedRevision: 0, requestId: crypto.randomUUID(), profile: createEmptyProfile() });
  req.headers.set('origin', 'https://other.example.test');
  expect((await PATCH(req)).status).toBe(403);
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', '');
  const unavailable = await PATCH(request('PATCH', {}));
  expect(unavailable.status).toBe(503); privateHeaders(unavailable);
  expect((await draftKey(request())).status).toBe(503);
  await db.delete(session).where(eq(session.userId, a.ownerId));
  expect((await GET(request())).status).toBe(401);
});
it('preserves authoritative auth Set-Cookie on success and validation errors', async () => {
  const handle = auth.handler.bind(auth);
  vi.spyOn(auth, 'handler').mockImplementation(async (req) => {
    const response = await handle(req);
    const headers = new Headers(response.headers);
    headers.append('set-cookie', 'synthetic_refresh=1; HttpOnly; Secure; SameSite=Lax');
    return new Response(response.body, { status: response.status, headers });
  });
  for (const response of [await GET(request()), await PATCH(request('PATCH', {})),
    await PATCH(request('PATCH', {}, b.cookie, '/api/profile', a.ownerId))]) {
    privateHeaders(response);
    expect(response.headers.getSetCookie()).toContain('synthetic_refresh=1; HttpOnly; Secure; SameSite=Lax');
  }
});
it('returns memory-only owner draft keys and disabled policy intent through actual handlers', async () => {
  const keyA = await draftKey(request());
  privateHeaders(keyA);
  const first = await keyA.json();
  const second = await (await draftKey(request('GET', undefined, b.cookie))).json();
  expect(first.ownerId).toBe(a.ownerId); expect(first.key).not.toBe(second.key);
  const saved = await policyPatch(request('PATCH', { expectedRevision: 0, requestId: crypto.randomUUID(), policy: createEmptyPolicy() }));
  expect(saved.status).toBe(200);
  expect(await saved.json()).toMatchObject({ revision: 1, enabled: false, runnerAvailable: false });
  expect((await policyPost(request('POST', { expectedRevision: 1, requestId: crypto.randomUUID(), action: 'enable' }))).status).toBe(409);
  expect(await (await policyGet(request())).json()).toMatchObject({ revision: 1, enabled: false });
});
it('bounds streaming JSON by bytes, ignores lying Content-Length, and rejects media/schema errors', async () => {
  const oversized = request('PATCH', 'x'.repeat(131073));
  oversized.headers.set('content-length', '1');
  expect((await PATCH(oversized)).status).toBe(413);
  const wrongType = request('PATCH', {});
  wrongType.headers.set('content-type', 'text/plain');
  expect((await PATCH(wrongType)).status).toBe(415);
  const invalid = new Request(`${origin}/api/profile`, {
    method: 'PATCH', headers: { origin, cookie: a.cookie, 'content-type': 'application/json', 'x-workie-applicant': a.ownerId }, body: '{',
  });
  expect((await PATCH(invalid)).status).toBe(400);
  const exact = JSON.stringify('x'.repeat(131070));
  expect(await readPrivateJson(new Request(origin, { method: 'POST', headers: { 'content-type': 'application/json' }, body: exact }), z.string())).toHaveLength(131070);
});
it('applies a durable per-principal limit without rate-limiting the other applicant', async () => {
  await db.insert(rateLimit).values({ id: crypto.randomUUID(), key: `private-applicant:${a.ownerId}`,
    count: 60, lastRequest: Math.floor(Date.now() / 60_000) * 60_000 });
  const response = await GET(request());
  expect(response.status).toBe(429); privateHeaders(response);
  expect((await GET(request('GET', undefined, b.cookie))).status).toBe(200);
});
it('times out all profile/policy writes without changing persisted revisions or losing private cookies', async () => {
  const profile = createEmptyProfile();
  const policy = createEmptyPolicy();
  expect((await PATCH(request('PATCH', { expectedRevision: 0, requestId: crypto.randomUUID(), profile }))).status).toBe(200);
  expect((await policyPatch(request('PATCH', { expectedRevision: 0, requestId: crypto.randomUUID(), policy }))).status).toBe(200);
  const snapshot = async () => ({
    profiles: await db.select().from(profileVersions), profileHeads: await db.select().from(profileHeads),
    policies: await db.select().from(policyVersions), policyHeads: await db.select().from(policyHeads),
    commands: await db.select().from(policyCommands),
  });
  const before = await snapshot();
  const handle = auth.handler.bind(auth);
  vi.spyOn(auth, 'handler').mockImplementation(async (req) => {
    const response = await handle(req);
    const headers = new Headers(response.headers);
    headers.append('set-cookie', 'synthetic_refresh=1; HttpOnly; Secure; SameSite=Lax');
    return new Response(response.body, { status: response.status, headers });
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    for (const [handler, method, input] of [
      [PATCH, 'PATCH', { expectedRevision: 1, requestId: crypto.randomUUID(), profile }],
      [policyPatch, 'PATCH', { expectedRevision: 1, requestId: crypto.randomUUID(), policy }],
      [policyPost, 'POST', { expectedRevision: 1, requestId: crypto.randomUUID(), action: 'disable' }],
    ] as const) {
      const body = new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(input))); },
        cancel() { return new Promise<void>(() => {}); },
      });
      let started!: () => void;
      const readingStarted = new Promise<void>((resolve) => { started = resolve; });
      const getReader = body.getReader.bind(body);
      vi.spyOn(body, 'getReader').mockImplementation(() => { const reader = getReader(); started(); return reader; });
      const req = new Request(`${origin}/api/profile`, {
        method, headers: request(method).headers, body, duplex: 'half',
      } as RequestInit & { duplex: 'half' });
      let response: Response | undefined;
      const pending = handler(req).then((value) => { response = value; });
      await readingStarted;
      await vi.advanceTimersByTimeAsync(8000);
      expect(response?.status).toBe(408);
      await pending;
      privateHeaders(response!);
      expect(response!.headers.getSetCookie()).toContain('synthetic_refresh=1; HttpOnly; Secure; SameSite=Lax');
      expect(await response!.json()).toEqual({ error: 'Request body timed out.' });
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
      expect(await snapshot()).toEqual(before);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});
