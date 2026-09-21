import { createHash } from 'node:crypto';
import { z } from 'zod';

const uuid = z.uuid();
const revision = z.number().int().positive().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const mime = z.enum(['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document']);

export const ApplicationArtifactManifestSchema = z.strictObject({
  schemaVersion: z.literal(1), applicationId: uuid,
  source: z.strictObject({ documentId: uuid, version: revision, sha256: hash }),
  output: z.strictObject({ sha256: hash, mime, size: z.number().int().positive().max(10 * 1024 * 1024) }),
  template: z.record(z.string().max(80), z.unknown()),
  request: z.record(z.string().max(80), z.unknown()),
  checks: z.strictObject({ pageCount: z.number().int().positive().max(100), linksPreserved: z.literal(true),
    frozenTextPreserved: z.literal(true), anchorsFit: z.literal(true) }),
  tool: z.strictObject({ name: z.string().trim().min(1).max(80), version: z.string().trim().min(1).max(80) }),
});
export type ApplicationArtifactManifest = z.infer<typeof ApplicationArtifactManifestSchema>;

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}

export function artifactManifestHash(value: unknown) {
  return createHash('sha256').update(canonical(ApplicationArtifactManifestSchema.parse(value))).digest('hex');
}

/** Stable across worker restarts; a new application or source/requirements seed gets a new upload id. */
export function artifactRequestId(seed: unknown) {
  const digest = createHash('sha256').update(canonical(seed)).digest('hex');
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-${(parseInt(digest[16], 16) & 0x3 | 0x8).toString(16)}${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

export const ArtifactIntentSchema = z.strictObject({
  protocolVersion: z.literal(1), requestId: uuid, fence: revision, expectedRevision: revision,
  manifest: ApplicationArtifactManifestSchema,
});
export const ArtifactIntentResponseSchema = z.strictObject({
  applicationId: uuid, artifactId: uuid, documentId: uuid, version: revision,
  sha256: hash, mime, size: z.number().int().positive().max(10 * 1024 * 1024),
  uploadPath: z.string().regex(/^\/api\/worker\/applications\/[0-9a-f-]{36}\/artifacts\/[0-9a-f-]{36}\/upload$/),
  replayed: z.boolean(),
});
export const ArtifactUploadHeaderSchema = z.strictObject({
  protocolVersion: z.literal(1), requestId: uuid, fence: revision, expectedRevision: revision,
});
export const ArtifactUploadResponseSchema = z.strictObject({
  applicationId: uuid, artifactId: uuid, documentId: uuid, version: revision,
  sha256: hash, state: z.literal('available'), replayed: z.boolean(),
});

export type ArtifactIntent = z.infer<typeof ArtifactIntentSchema>;
export type ArtifactIntentResponse = z.infer<typeof ArtifactIntentResponseSchema>;
export type ArtifactUploadHeader = z.infer<typeof ArtifactUploadHeaderSchema>;
export type ArtifactUploadResponse = z.infer<typeof ArtifactUploadResponseSchema>;
