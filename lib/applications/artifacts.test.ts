import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { PDFDocument } from 'pdf-lib';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from '../private-db';
import { account, applicationArtifacts, applicationRuns, applications, policyHeads, policyVersions, user, workerPairings, workers } from '../private-db/schema';
import { createEmptyPolicy } from './policy';
import { createDocumentGrant, receiveLocalDocument } from './documents';
import { artifactManifestHash } from './artifact-protocol';
import { createArtifactIntent, uploadArtifact } from './artifacts';
import { hashValue } from './stores';
import { secretHash } from './worker-store';

vi.mock('server-only', () => ({}));

const ownerId = 'one';
const token = 'T'.repeat(43);
const now = 1_700_000_000_000;
const PDF = 'application/pdf';
let db: PrivateDb;
let dir: string;

function policy() {
  return {
    ...createEmptyPolicy(), actions: ['read_jobs'] as ['read_jobs'], destinations: ['example.test'], countries: ['US'],
  };
}

async function fixture() {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'workie-artifacts-')));
  db = openPrivateDb({ url: pathToFileURL(join(dir, 'private.db')).href });
  await migratePrivateDb(db);
  vi.stubEnv('WORKIE_DOCUMENT_STORAGE', 'local');
  vi.stubEnv('WORKIE_DOCUMENT_DIRECTORY', join(dir, 'objects'));
  await db.insert(user).values({ id: ownerId, name: ownerId, email: 'one@example.test', emailVerified: true });
  const accountId = randomUUID(), password = 'synthetic-account-password';
  await db.insert(account).values({ id: accountId, accountId: 'credential', providerId: 'credential', userId: ownerId, password });
  const savedPolicy = policy(), policyHash = hashValue(savedPolicy);
  await db.insert(policyVersions).values({ ownerId, version: 1, hash: policyHash, policy: savedPolicy, createdAt: now });
  await db.insert(policyHeads).values({ ownerId, revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: policyHash, acceptedAt: now });
  const pairingId = randomUUID(), workerId = randomUUID(), runId = randomUUID(), applicationId = randomUUID();
  const binding = hashValue([accountId, password]);
  await db.insert(workerPairings).values({ id: pairingId, ownerId, grantHash: 'g'.repeat(64), credentialBinding: binding,
    label: 'synthetic', requestId: randomUUID(), expiresAt: now + 86_400_000, consumedAt: now });
  await db.insert(workers).values({ id: workerId, ownerId, pairingId, tokenHash: secretHash(token), credentialBinding: binding,
    registrationId: 'registration', registrationHash: 'r'.repeat(64), label: 'synthetic', protocolVersion: 1,
    workerVersion: 'test', capabilities: ['control-v1'], createdAt: now });
  await db.insert(applicationRuns).values({ id: runId, ownerId, workerId, policyRevision: 1, policyVersion: 1,
    policyHash, createdAt: now });
  await db.insert(applications).values({ id: applicationId, ownerId, runId, workerId, ats: 'greenhouse', tenant: 'example.test',
    requisition: 'req-1', state: 'tailoring', revision: 1, fence: 1, leaseUntil: now + 120_000,
    leaseCheckedAt: now, availableAt: now, createdAt: now });
  const pdf = await PDFDocument.create();
  pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const grant = await createDocumentGrant(db, ownerId, { requestId: randomUUID(), kind: 'resume_master', name: 'master.pdf', mime: PDF, size: bytes.length }, {
    mode: 'local', directory: join(dir, 'objects'),
  });
  const source = await receiveLocalDocument(db, ownerId, grant.grantId, new Request('http://localhost', {
    method: 'PUT', headers: { 'content-type': PDF }, body: bytes,
  }), { mode: 'local', directory: join(dir, 'objects') });
  if (!source.sha256) throw new Error('synthetic master was not hashed');
  return { applicationId, source: { ...source, sha256: source.sha256 }, bytes, storage: { mode: 'local' as const, directory: join(dir, 'objects') } };
}

function manifest(applicationId: string, source: { id: string; version: number; sha256: string }, bytes: Uint8Array) {
  const outputHash = createHash('sha256').update(bytes).digest('hex');
  return {
    schemaVersion: 1 as const, applicationId,
    source: { documentId: source.id, version: source.version, sha256: source.sha256 },
    output: { sha256: outputHash, mime: PDF, size: bytes.length },
    template: { role: 'software engineering' }, request: { role: 'software engineering', masterHash: source.sha256 },
    checks: { pageCount: 1, linksPreserved: true as const, frozenTextPreserved: true as const, anchorsFit: true as const },
    tool: { name: 'synthetic', version: '1' },
  };
}

const options = { now: () => now, isAllowedApplicant: () => true };
const intentInput = (applicationId: string, source: { id: string; version: number; sha256: string }, bytes: Uint8Array) => ({
  protocolVersion: 1 as const, requestId: randomUUID(), fence: 1, expectedRevision: 1,
  manifest: manifest(applicationId, source, bytes),
});

afterEach(() => { vi.unstubAllEnvs(); db?.$client.close(); if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('application artifact protocol', () => {
  it('replays intent and upload without creating a second artifact', async () => {
    const { applicationId, source, bytes } = await fixture();
    const input = intentInput(applicationId, source, bytes);
    const first = await createArtifactIntent(db, token, applicationId, input, options);
    const replay = await createArtifactIntent(db, token, applicationId, input, options);
    expect(replay).toMatchObject({ artifactId: first.artifactId, documentId: first.documentId, replayed: true });
    const headers = { 'content-type': PDF, 'x-workie-protocol-version': '1', 'x-workie-request-id': input.requestId,
      'x-workie-fence': '1', 'x-workie-revision': '1' };
    const upload = () => uploadArtifact(db, token, applicationId, first.artifactId,
      new Request('http://localhost/upload', { method: 'POST', headers, body: bytes }), options);
    expect(await upload()).toMatchObject({ state: 'available', replayed: false, sha256: first.sha256 });
    expect(await upload()).toMatchObject({ state: 'available', replayed: true, sha256: first.sha256 });
    expect(await db.all(sql`select count(*) as n from private_application_artifact`)).toEqual([{ n: 1 }]);
  });

  it('rejects stale leases, mismatched manifests, and forged bytes', async () => {
    const { applicationId, source, bytes } = await fixture();
    const input = intentInput(applicationId, source, bytes);
    const badManifest = { ...input, manifest: { ...input.manifest, source: { ...input.manifest.source, sha256: 'a'.repeat(64) } } };
    await expect(createArtifactIntent(db, token, applicationId, badManifest, options)).rejects.toMatchObject({ code: 'ARTIFACT_MANIFEST_MISMATCH' });
    const intent = await createArtifactIntent(db, token, applicationId, input, options);
    await expect(uploadArtifact(db, token, applicationId, intent.artifactId, new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': PDF, 'x-workie-protocol-version': '1', 'x-workie-request-id': input.requestId,
        'x-workie-fence': '1', 'x-workie-revision': '1' }, body: Buffer.alloc(bytes.length),
    }), options)).rejects.toMatchObject({ code: 'ARTIFACT_HASH_MISMATCH' });
    await db.update(applications).set({ leaseUntil: now - 1, leaseCheckedAt: now - 2 }).where(eq(applications.id, applicationId));
    await expect(createArtifactIntent(db, token, applicationId, { ...input, requestId: randomUUID() }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });

  it('persists a hash-bound manifest and makes its records immutable', async () => {
    const { applicationId, source, bytes } = await fixture();
    const input = intentInput(applicationId, source, bytes);
    const intent = await createArtifactIntent(db, token, applicationId, input, options);
    await uploadArtifact(db, token, applicationId, intent.artifactId, new Request('http://localhost/upload', {
      method: 'POST', headers: { 'content-type': PDF, 'x-workie-protocol-version': '1', 'x-workie-request-id': input.requestId,
        'x-workie-fence': '1', 'x-workie-revision': '1' }, body: bytes,
    }), options);
    const [row] = await db.select().from(applicationArtifacts);
    expect(row.manifestHash).toBe(artifactManifestHash(row.manifest));
    await expect(db.run(sql`update private_application_artifact set output_hash = ${'b'.repeat(64)}`)).rejects.toThrow();
    await expect(db.run(sql`delete from private_application_artifact`)).rejects.toThrow();
  });
});
