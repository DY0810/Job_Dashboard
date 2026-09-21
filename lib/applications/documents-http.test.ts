import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PDFDocument } from 'pdf-lib';
import { getPayloadFromClientToken } from '@vercel/blob/client';
import { get } from '@vercel/blob';
import { createDocumentGrant, listDocuments, retryDocumentValidation } from './documents';
import { handleDocumentRequest, handleDocumentBlobRequest } from './documents-http';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from '../private-db';
import { user } from '../private-db/schema';
import type { ApplicantAuth } from '../auth';
import { documentStorageConfig, type DocumentStorage } from './documents-storage';
import { eq } from 'drizzle-orm';
import { documentUploadGrants } from '../private-db/document-schema';

vi.mock('server-only', () => ({}));
vi.mock('@vercel/blob', async (original) => {
  const actual = await original<typeof import('@vercel/blob')>();
  return { ...actual, get: vi.fn() };
});
let dir: string, db: PrivateDb, bytes: Uint8Array;
const origin = 'https://app.example.test';
const token = 'vercel_blob_rw_synthetic_abcdefghijklmnopqrstuvwxyz123456';
const storage: DocumentStorage = { mode: 'blob', token, origin: 'https://synthetic.private.blob.vercel-storage.com', callbackUrl: `${origin}/api/documents/upload` };
const auth = {
  origin, isAllowedApplicant: () => true,
  handler: async (request: Request) => {
    const id = request.headers.get('cookie');
    return Response.json(id ? { user: { id, email: `${id}@example.test`, name: id, emailVerified: true }, session: { userId: id } } : null,
      { headers: { 'Set-Cookie': 'session=synthetic; HttpOnly' } });
  },
} as unknown as ApplicantAuth;
const req = (body: unknown, owner = 'one', headers = {}) => new Request(`${origin}/api/documents/upload`, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: owner,
    ...(owner ? { 'x-workie-applicant': owner } : {}), ...headers }, body: JSON.stringify(body),
});
beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in synthetic tests'); }));
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'workie-doc-http-')));
  db = openPrivateDb({ url: pathToFileURL(join(dir, 'private.db')).href });
  await migratePrivateDb(db);
  for (const id of ['one', 'two']) await db.insert(user).values({ id, name: id, email: `${id}@example.test` });
  const pdf = await PDFDocument.create(); pdf.addPage(); bytes = await pdf.save();
  vi.mocked(get).mockImplementation(async () => ({
    statusCode: 200, stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
    headers: new Headers(),
    blob: { url: '', downloadUrl: '', contentDisposition: 'attachment', cacheControl: 'no-store',
      contentType: 'application/pdf', pathname: '', size: bytes.length, uploadedAt: new Date(), etag: 'untrusted' },
  }));
});
afterEach(() => { vi.unstubAllGlobals(); db?.$client.close(); rmSync(dir, { recursive: true, force: true }); });
const grant = () => createDocumentGrant(db, 'one', {
  requestId: randomUUID(), kind: 'resume_master', name: 'synthetic.pdf', mime: 'application/pdf', size: bytes.length,
}, storage);
it('requires owner session and origin on list, grant creation and download', async () => {
  const item = await grant();
  const options = { db, storage, auth };
  const unauth = await handleDocumentRequest(new Request(`${origin}/api/documents`), 'list', undefined, options);
  expect(unauth.status).toBe(401);
  const listing = await handleDocumentRequest(new Request(`${origin}/api/documents`, { headers: { cookie: 'two' } }), 'list', undefined, options);
  expect(await listing.json()).toEqual({ documents: [], storage: 'blob' });
  expect(listing.headers.get('Cache-Control')).toBe('private, no-store');
  expect(listing.headers.get('Set-Cookie')).toContain('synthetic');
  const download = await handleDocumentRequest(new Request(`${origin}/api/documents/${item.document.id}/download`, { headers: { cookie: 'two' } }), 'download', item.document.id, options);
  expect(download.status).toBe(404);
  const denied = await handleDocumentRequest(req({}, 'one', { Origin: 'https://evil.example.test' }), 'create', undefined, options);
  expect(denied.status).toBe(403);
});
it('rejects switched or missing applicants before grant, raw upload, validation or SDK-token writes', async () => {
  const item = await grant();
  const options = { db, storage, auth };
  const create = { requestId: randomUUID(), kind: 'resume_master', name: 'private-a.pdf', mime: 'application/pdf', size: bytes.length };
  const tokenBody = { type: 'blob.generate-client-token', payload: {
    pathname: item.pathname, clientPayload: JSON.stringify({ grantId: item.grantId }), multipart: false,
  } };
  const before = await db.select().from(documentUploadGrants);
  for (const missing of [false, true]) {
    for (const action of ['create', 'local-upload', 'validate', 'token'] as const) {
      const switched = req(action === 'token' ? tokenBody : create, 'two', { 'x-workie-applicant': 'one' });
      if (missing) switched.headers.delete('x-workie-applicant');
      const response = action === 'token' ? await handleDocumentBlobRequest(switched, options)
        : await handleDocumentRequest(switched, action, action === 'local-upload' ? item.grantId : item.document.id, options);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Applicant session changed. Unlock the current account.' });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('set-cookie')).toContain('synthetic');
      expect(switched.bodyUsed).toBe(false);
      expect(await db.select().from(documentUploadGrants)).toEqual(before);
      expect(await listDocuments(db, 'two')).toEqual([]);
      expect((await listDocuments(db, 'one'))[0]).toMatchObject({ state: 'pending', sha256: null });
    }
  }
  expect((await handleDocumentRequest(req(create), 'create', undefined, options)).status).toBe(201);
  expect((await handleDocumentBlobRequest(req(tokenBody), options)).status).toBe(200);
  const forgedCallbackHeader = req(tokenBody, '', { 'x-vercel-signature': '0'.repeat(64) });
  expect((await handleDocumentBlobRequest(forgedCallbackHeader, options)).status).toBe(403);
  expect(get).not.toHaveBeenCalled();
});
it('real SDK creates a single-object constrained token, never a whole-store token', async () => {
  const item = await grant();
  const body = { type: 'blob.generate-client-token', payload: { pathname: item.pathname, clientPayload: JSON.stringify({ grantId: item.grantId }), multipart: false } };
  const result = await handleDocumentBlobRequest(req(body), { db, storage, auth });
  expect(result.status).toBe(200);
  const data = await result.json();
  expect(data.clientToken).not.toBe(token);
  const payload = getPayloadFromClientToken(data.clientToken);
  expect(payload).toMatchObject({
    pathname: item.pathname, allowedContentTypes: ['application/pdf'], maximumSizeInBytes: bytes.length,
    allowOverwrite: false, addRandomSuffix: false,
    onUploadCompleted: { callbackUrl: storage.callbackUrl, tokenPayload: JSON.stringify({ grantId: item.grantId }) },
  });
  expect(payload.validUntil).toBeGreaterThan(Date.now());
  expect(payload.validUntil).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  expect((await handleDocumentBlobRequest(req(body, 'two'), { db, storage, auth })).status).toBe(404);
  expect((await handleDocumentBlobRequest(req({ ...body, payload: { ...body.payload, pathname: `documents/${randomUUID()}` } }), { db, storage, auth })).status).toBe(409);
  expect((await handleDocumentBlobRequest(req(body, ''), { db, storage, auth })).status).toBe(401);
  expect((await handleDocumentBlobRequest(req(body, 'one', { Origin: 'https://evil.example.test' }), { db, storage, auth })).status).toBe(403);
  expect((await handleDocumentBlobRequest(req({ ...body, payload: { ...body.payload, multipart: true } }), { db, storage, auth })).status).toBe(400);
});
it('real SDK validates synthetic HMAC over unchanged parsed body, idempotent callbacks and conflicting callback rejection', async () => {
  const item = await grant();
  await handleDocumentBlobRequest(req({ type: 'blob.generate-client-token', payload: {
    pathname: item.pathname, multipart: false, clientPayload: JSON.stringify({ grantId: item.grantId }),
  } }), { db, storage, auth });
  const body = { extraSignedField: 'preserve-order', type: 'blob.upload-completed', payload: {
    tokenPayload: JSON.stringify({ grantId: item.grantId }),
    blob: { url: `${storage.origin}/${item.pathname}`, pathname: item.pathname, contentType: 'application/pdf', contentDisposition: 'attachment', downloadUrl: 'not-trusted' },
  } };
  const signed = (value: unknown) => req(value, '', { 'x-vercel-signature': createHmac('sha256', token).update(JSON.stringify(value)).digest('hex') });
  // Unsigned requests now authenticate before reading a browser-controlled body.
  expect((await handleDocumentBlobRequest(req(body, ''), { db, storage, auth })).status).toBe(401);
  expect((await handleDocumentBlobRequest(req(body, '', { 'x-vercel-signature': '0'.repeat(64) }), { db, storage, auth })).status).toBe(403);
  const other = await createDocumentGrant(db, 'two', {
    requestId: randomUUID(), kind: 'resume_master', name: 'synthetic-b.pdf', mime: 'application/pdf', size: bytes.length,
  }, storage);
  expect((await handleDocumentBlobRequest(req({ type: 'blob.generate-client-token', payload: {
    pathname: other.pathname, multipart: false, clientPayload: JSON.stringify({ grantId: other.grantId }),
  } }, 'two'), { db, storage, auth })).status).toBe(200);
  const beforeMismatch = await listDocuments(db, 'two');
  expect((await handleDocumentBlobRequest(signed({ ...body, payload: {
    ...body.payload, tokenPayload: JSON.stringify({ grantId: other.grantId }),
  } }), { db, storage, auth })).status).toBe(409);
  expect(await listDocuments(db, 'two')).toEqual(beforeMismatch);
  expect((await listDocuments(db, 'one'))[0].state).toBe('pending');
  expect(get).not.toHaveBeenCalled();
  const first = await handleDocumentBlobRequest(signed(body), { db, storage, auth });
  expect(first.status).toBe(200);
  expect((await listDocuments(db, 'one'))[0]).toMatchObject({ state: 'available', safetyCheck: 'passed' });
  const before = vi.mocked(get).mock.calls.length;
  expect((await handleDocumentBlobRequest(signed(body), { db, storage, auth })).status).toBe(200);
  expect(get).toHaveBeenCalledTimes(before);
  const conflict = { ...body, payload: { ...body.payload, blob: { ...body.payload.blob, url: 'https://evil.example.test/object' } } };
  expect((await handleDocumentBlobRequest(signed(conflict), { db, storage, auth })).status).toBe(409);
  expect((await listDocuments(db, 'one'))[0].size).toBe(bytes.length);
  const downloaded = await handleDocumentRequest(new Request(`${origin}/api/documents/${item.document.id}/download`, {
    headers: { cookie: 'one' },
  }), 'download', item.document.id, { db, storage, auth });
  expect(downloaded.status).toBe(200);
  expect(downloaded.headers.get('content-disposition')).toContain('attachment;');
  expect(downloaded.headers.get('cache-control')).toBe('private, no-store');
  expect(downloaded.headers.get('x-content-type-options')).toBe('nosniff');
  expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(bytes);
});
it('keeps unavailable provider bytes quarantined, retries validation and rejects expired callbacks', async () => {
  const item = await grant();
  await handleDocumentBlobRequest(req({ type: 'blob.generate-client-token', payload: {
    pathname: item.pathname, multipart: false, clientPayload: JSON.stringify({ grantId: item.grantId }),
  } }), { db, storage, auth });
  const body = { type: 'blob.upload-completed', payload: {
    tokenPayload: JSON.stringify({ grantId: item.grantId }),
    blob: { url: `${storage.origin}/${item.pathname}`, pathname: item.pathname, contentType: 'application/pdf' },
  } };
  const signed = () => req(body, '', { 'x-vercel-signature': createHmac('sha256', token).update(JSON.stringify(body)).digest('hex') });
  vi.mocked(get).mockRejectedValueOnce(new Error('synthetic provider unavailable'));
  expect((await handleDocumentBlobRequest(signed(), { db, storage, auth })).status).toBe(200);
  expect((await listDocuments(db, 'one'))[0]).toMatchObject({ state: 'quarantined', safetyCheck: 'deferred', downloadUrl: null });
  expect((await retryDocumentValidation(db, 'one', item.document.id, storage)).state).toBe('available');
  const expired = await grant();
  await db.update(documentUploadGrants).set({ tokenIssued: true, expiresAt: Date.now() - 1 }).where(eq(documentUploadGrants.id, expired.grantId));
  body.payload.tokenPayload = JSON.stringify({ grantId: expired.grantId });
  body.payload.blob = { url: `${storage.origin}/${expired.pathname}`, pathname: expired.pathname, contentType: 'application/pdf' };
  expect((await handleDocumentBlobRequest(signed(), { db, storage, auth })).status).toBe(409);
  expect((await listDocuments(db, 'one')).find((d) => d.id === expired.document.id)?.state).toBe('pending');
});
it('fails closed on local/cloud configuration mismatches without reaching a provider', () => {
  expect(documentStorageConfig({})).toEqual({ mode: 'unconfigured' });
  const config = {
    WORKIE_DOCUMENT_STORAGE: 'blob', VERCEL: '1', BLOB_READ_WRITE_TOKEN: token,
    WORKIE_DOCUMENT_BLOB_ORIGIN: storage.origin, WORKIE_DOCUMENT_CALLBACK_URL: storage.callbackUrl,
    BETTER_AUTH_URL: origin,
  };
  expect(documentStorageConfig(config)).toEqual(storage);
  for (const change of [
    { VERCEL: undefined }, { BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_other_synthetic' },
    { WORKIE_DOCUMENT_BLOB_ORIGIN: 'https://synthetic.public.blob.vercel-storage.com' },
    { WORKIE_DOCUMENT_CALLBACK_URL: 'https://evil.example.test/api/documents/upload' },
    { WORKIE_DOCUMENT_CALLBACK_URL: `${origin}/api/documents/upload?extra=1` },
    { WORKIE_DOCUMENT_STORAGE: 'local', WORKIE_DOCUMENT_DIRECTORY: dir },
  ]) expect(() => documentStorageConfig({ ...config, ...change })).toThrow();
  expect(documentStorageConfig({ WORKIE_DOCUMENT_STORAGE: 'local', WORKIE_DOCUMENT_DIRECTORY: join(dir, 'objects') })).toEqual({
    mode: 'local', directory: join(dir, 'objects'),
  });
  expect(fetch).not.toHaveBeenCalled();
});
