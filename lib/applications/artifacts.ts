import 'server-only';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationArtifacts, documents } from '../private-db/schema.ts';
import {
  ArtifactIntentSchema, ArtifactIntentResponseSchema, ArtifactUploadHeaderSchema, ArtifactUploadResponseSchema,
  ApplicationArtifactManifestSchema, artifactManifestHash, type ArtifactIntentResponse, type ArtifactUploadResponse,
} from './artifact-protocol.ts';
import { boundedDocumentBytes, documentStorageConfig, DocumentError, readDocumentObject, writeDocumentObject } from './documents-storage.ts';
import { validateDocumentBytes } from './documents-validation.ts';
import { checkedLease } from './leases.ts';
import { withWorker, type WorkerOptions, WorkerError } from './worker-store.ts';

const uuid = z.uuid();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const uploadPath = (applicationId: string, artifactId: string) => `/api/worker/applications/${applicationId}/artifacts/${artifactId}/upload`;

function storageOrFail() {
  try { return documentStorageConfig(); }
  catch { throw new WorkerError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Private document storage is unavailable.'); }
}

function documentFailure(error: unknown): WorkerError {
  if (error instanceof WorkerError) return error;
  if (error instanceof DocumentError) return new WorkerError(error.status, 'DOCUMENT_UPLOAD_FAILED', error.message);
  return new WorkerError(503, 'DOCUMENT_UPLOAD_FAILED', 'Application artifact storage failed.');
}

function responseFor(applicationId: string, artifact: typeof applicationArtifacts.$inferSelect, document: typeof documents.$inferSelect, replayed: boolean): ArtifactIntentResponse {
  return ArtifactIntentResponseSchema.parse({ applicationId, artifactId: artifact.id, documentId: document.id, version: document.version,
    sha256: artifact.outputHash, mime: document.mime, size: document.size, uploadPath: uploadPath(applicationId, artifact.id), replayed });
}

function validateManifest(input: unknown, applicationId: string, source: typeof documents.$inferSelect) {
  const manifest = ApplicationArtifactManifestSchema.parse(input);
  if (!source.sha256 || manifest.applicationId !== applicationId || manifest.source.documentId !== source.id ||
      manifest.source.version !== source.version || manifest.source.sha256 !== source.sha256 || manifest.output.mime !== source.mime ||
      artifactManifestHash(manifest) !== artifactManifestHash(input)) {
    throw new WorkerError(409, 'ARTIFACT_MANIFEST_MISMATCH', 'Application artifact manifest does not match the selected master.');
  }
  return manifest;
}

export async function createArtifactIntent(
  db: PrivateDb, token: string, applicationId: string, input: unknown, options: WorkerOptions = {},
) {
  if (!uuid.safeParse(applicationId).success) throw new WorkerError(400, 'INVALID_INPUT', 'Invalid application ID.');
  const command = ArtifactIntentSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const checked = await checkedLease(tx, worker, { applicationId, fence: command.fence, expectedRevision: command.expectedRevision }, now);
    if (checked instanceof WorkerError) return checked;
    const [source] = await tx.select().from(documents).where(and(
      eq(documents.ownerId, worker.ownerId), eq(documents.id, command.manifest.source.documentId),
      eq(documents.version, command.manifest.source.version), eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed'),
    ));
    if (!source || !source.sha256) throw new WorkerError(409, 'SOURCE_DOCUMENT_UNAVAILABLE', 'The selected master resume is unavailable.');
    const manifest = validateManifest(command.manifest, applicationId, source);
    const storage = storageOrFail();
    if (storage.mode === 'unconfigured') throw new WorkerError(503, 'DOCUMENT_STORAGE_UNAVAILABLE', 'Private document storage is unavailable.');
    const [existing] = await tx.select({ artifact: applicationArtifacts, document: documents }).from(applicationArtifacts)
      .innerJoin(documents, and(eq(documents.ownerId, applicationArtifacts.ownerId), eq(documents.id, applicationArtifacts.documentId)))
      .where(and(eq(applicationArtifacts.ownerId, worker.ownerId), eq(applicationArtifacts.requestId, command.requestId)));
    if (existing) {
      if (existing.artifact.applicationId !== applicationId || existing.artifact.manifestHash !== artifactManifestHash(manifest) ||
          existing.artifact.outputHash !== manifest.output.sha256 || existing.artifact.sourceHash !== source.sha256) {
        throw new WorkerError(409, 'ARTIFACT_REQUEST_CONFLICT', 'The artifact request ID was already used for different content.');
      }
      return responseFor(applicationId, existing.artifact, existing.document, true);
    }
    if (checked.state !== 'tailoring') throw new WorkerError(409, 'ARTIFACT_STAGE_INVALID', 'Artifacts can only be created during tailoring.');
    const [latest] = await tx.select({ version: sql<number>`coalesce(max(${documents.version}), 0)` }).from(documents)
      .where(and(eq(documents.ownerId, worker.ownerId), eq(documents.masterId, source.masterId)));
    const documentId = randomUUID(), artifactId = randomUUID(), version = Number(latest?.version ?? 0) + 1;
    const suffix = source.mime === 'application/pdf' ? '.pdf' : '.docx';
    const templateRole = typeof manifest.template.role === 'string' ? manifest.template.role : null;
    const name = `application-${applicationId.slice(0, 8)}-${source.name.replace(/[\/\x00-\x1f\x7f]/g, '-').slice(0, 155)}${suffix}`;
    const [document] = await tx.insert(documents).values({
      id: documentId, ownerId: worker.ownerId, kind: 'resume_artifact', name, role: templateRole,
      parentId: source.id, masterId: source.masterId, version, objectKey: `documents/${documentId}`,
      storage: storage.mode, mime: source.mime, size: manifest.output.size, state: 'pending', safetyCheck: 'pending', createdAt: now,
    }).returning();
    const [artifact] = await tx.insert(applicationArtifacts).values({
      id: artifactId, ownerId: worker.ownerId, applicationId, requestId: command.requestId,
      sourceDocumentId: source.id, sourceVersion: source.version, sourceHash: source.sha256,
      documentId: document.id, outputHash: manifest.output.sha256, manifestHash: artifactManifestHash(manifest), manifest, createdAt: now,
    }).returning();
    return responseFor(applicationId, artifact, document, false);
  });
}

async function writeOrVerify(storage: ReturnType<typeof documentStorageConfig>, key: string, bytes: Uint8Array, expectedHash: string) {
  try {
    await writeDocumentObject(storage, key, bytes);
    return;
  } catch (error) {
    try {
      const existing = await readDocumentObject(storage, key);
      if (existing.length === bytes.length && digest(existing) === expectedHash) return;
    } catch { /* The original write failure remains the actionable error. */ }
    throw error;
  }
}

export async function uploadArtifact(
  db: PrivateDb, token: string, applicationId: string, artifactId: string, request: Request, options: WorkerOptions = {},
) : Promise<ArtifactUploadResponse> {
  if (!uuid.safeParse(applicationId).success || !uuid.safeParse(artifactId).success) throw new WorkerError(400, 'INVALID_INPUT', 'Invalid artifact path.');
  if (request.method !== 'POST' || new URL(request.url).search) throw new WorkerError(400, 'INVALID_INPUT', 'Invalid artifact upload request.');
  const header = ArtifactUploadHeaderSchema.parse({
    protocolVersion: Number(request.headers.get('x-workie-protocol-version')),
    requestId: request.headers.get('x-workie-request-id'), fence: Number(request.headers.get('x-workie-fence')),
    expectedRevision: Number(request.headers.get('x-workie-revision')),
  });
  const prepared = await withWorker(db, token, options, async (tx, worker, now) => {
    const checked = await checkedLease(tx, worker, { applicationId, fence: header.fence, expectedRevision: header.expectedRevision }, now);
    if (checked instanceof WorkerError) return checked;
    const [row] = await tx.select({ artifact: applicationArtifacts, document: documents }).from(applicationArtifacts)
      .innerJoin(documents, and(eq(documents.ownerId, applicationArtifacts.ownerId), eq(documents.id, applicationArtifacts.documentId)))
      .where(and(eq(applicationArtifacts.ownerId, worker.ownerId), eq(applicationArtifacts.id, artifactId), eq(applicationArtifacts.applicationId, applicationId),
        eq(applicationArtifacts.requestId, header.requestId)));
    if (!row) throw new WorkerError(404, 'ARTIFACT_NOT_FOUND', 'Application artifact upload was not found.');
    if (row.document.state === 'available' && row.document.sha256 === row.artifact.outputHash) {
      return { ...row, replayed: true };
    }
    if (!['pending', 'quarantined'].includes(row.document.state)) throw new WorkerError(409, 'ARTIFACT_NOT_UPLOADABLE', 'Application artifact is not uploadable.');
    return { ...row, replayed: false };
  });
  if (prepared.replayed) return ArtifactUploadResponseSchema.parse({ applicationId, artifactId, documentId: prepared.document.id,
    version: prepared.document.version, sha256: prepared.artifact.outputHash, state: 'available', replayed: true });
  let bytes: Uint8Array;
  try {
    if (request.headers.get('content-type')?.split(';')[0] !== prepared.document.mime) throw new WorkerError(415, 'DOCUMENT_TYPE_MISMATCH', 'Artifact type does not match its manifest.');
    bytes = await boundedDocumentBytes(request.body, prepared.document.size);
  } catch (error) { throw documentFailure(error); }
  if (bytes.length !== prepared.document.size || digest(bytes) !== prepared.artifact.outputHash) {
    throw new WorkerError(422, 'ARTIFACT_HASH_MISMATCH', 'Artifact bytes do not match the manifest.');
  }
  const validation = await validateDocumentBytes(bytes, prepared.document.mime);
  const storage = storageOrFail();
  try { await writeOrVerify(storage, prepared.document.objectKey, bytes, prepared.artifact.outputHash); }
  catch (error) { throw documentFailure(error); }
  if (validation.status !== 'passed') {
    await withWorker(db, token, options, async (tx, worker, now) => {
      const checked = await checkedLease(tx, worker, { applicationId, fence: header.fence, expectedRevision: header.expectedRevision }, now);
      if (checked instanceof WorkerError) return checked;
      await tx.update(documents).set({ state: validation.status === 'rejected' ? 'rejected' : 'quarantined', safetyCheck: validation.status,
        sha256: validation.sha256, leaseId: null, leaseUntil: null }).where(and(eq(documents.ownerId, worker.ownerId), eq(documents.id, prepared.document.id)));
      return null;
    });
    throw new WorkerError(validation.status === 'rejected' ? 422 : 503, validation.status === 'rejected' ? 'ARTIFACT_REJECTED' : 'ARTIFACT_VALIDATION_DEFERRED',
      validation.status === 'rejected' ? 'Artifact validation rejected the output.' : 'Artifact validation is deferred; retry the same upload.');
  }
  return withWorker(db, token, options, async (tx, worker, now) => {
    const checked = await checkedLease(tx, worker, { applicationId, fence: header.fence, expectedRevision: header.expectedRevision }, now);
    if (checked instanceof WorkerError) return checked;
    const [updated] = await tx.update(documents).set({ state: 'available', safetyCheck: 'passed', sha256: validation.sha256,
      leaseId: null, leaseUntil: null }).where(and(eq(documents.ownerId, worker.ownerId), eq(documents.id, prepared.document.id),
        sql`${documents.state} in ('pending','quarantined')`)).returning();
    if (!updated) {
      const [current] = await tx.select().from(documents).where(and(eq(documents.ownerId, worker.ownerId), eq(documents.id, prepared.document.id)));
      if (current?.state === 'available' && current.sha256 === prepared.artifact.outputHash) {
        return ArtifactUploadResponseSchema.parse({ applicationId, artifactId, documentId: current.id, version: current.version,
          sha256: current.sha256, state: 'available', replayed: true });
      }
      throw new WorkerError(409, 'ARTIFACT_UPLOAD_CONFLICT', 'Artifact upload state changed.');
    }
    return ArtifactUploadResponseSchema.parse({ applicationId, artifactId, documentId: updated.id, version: updated.version,
      sha256: updated.sha256, state: 'available', replayed: false });
  });
}
