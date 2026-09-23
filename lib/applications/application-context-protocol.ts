import { z } from 'zod';
import { ApplicationIdentitySchema, WORKER_PROTOCOL_VERSION } from './worker-protocol.ts';

const uuid = z.uuid();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const timestamp = z.number().int().nonnegative().safe();
const value = z.union([z.string().trim().max(4000), z.boolean()]);

export const ScreeningFactsSchema = z.strictObject({
  countries: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  degreeLevels: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  majors: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  availableTerms: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  workAuthorization: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), values: z.array(z.string().trim().min(1).max(160)).max(100) }),
  pay: z.strictObject({ state: z.enum(['confirmed', 'unknown', 'declined']), currency: z.string().regex(/^[A-Z]{3}$/).nullable(),
    amount: z.number().finite().nonnegative().nullable(), period: z.enum(['hour', 'year']).nullable() }),
});

export const ScreeningRequirementsSchema = z.strictObject({
  sourceUrl: z.url({ protocol: /^https?$/ }),
  officialDescription: z.string().trim().min(1).max(100_000),
  excerpts: z.array(z.string().trim().min(1).max(1000)).min(1).max(32),
  countries: z.array(z.string().regex(/^[A-Z]{2}$/)).max(100),
  degreeLevels: z.array(z.string().trim().min(1).max(100)).max(20),
  majors: z.array(z.string().trim().min(1).max(160)).max(100),
  terms: z.array(z.string().trim().min(1).max(100)).max(20),
  authorizationRequired: z.boolean(), paid: z.boolean().nullable(),
  payFloor: z.strictObject({ currency: z.string().regex(/^[A-Z]{3}$/), amount: z.number().finite().nonnegative(), period: z.enum(['hour', 'year']) }).nullable(),
});

export const ApplicationContextRequestSchema = z.strictObject({
  protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), applicationId: uuid, fence: z.number().int().positive().safe(),
  expectedRevision: z.number().int().positive().safe(),
});

export const ApplicationDocumentSchema = z.strictObject({
  documentId: uuid, version: z.number().int().positive().safe(), sha256: hash,
  size: z.number().int().positive().max(10 * 1024 * 1024), mime: z.enum([
    'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ]), path: z.string().regex(/^\/api\/worker\/applications\/[0-9a-f-]{36}\/documents\/[0-9a-f-]{36}$/),
});

export const TailoredArtifactSchema = z.strictObject({
  documentId: uuid, version: z.number().int().positive().safe(), sourceDocumentId: uuid,
  sourceVersion: z.number().int().positive().safe(), sourceHash: hash,
  verificationManifestHash: hash, outputHash: hash,
});

export const ApplicationContextSchema = z.strictObject({
  protocolVersion: z.literal(WORKER_PROTOCOL_VERSION), applicationId: uuid, runId: uuid, ownerId: z.string().min(1).max(256),
  policyRevision: z.number().int().positive().safe(), identity: ApplicationIdentitySchema,
  company: z.string().trim().min(1).max(200), role: z.string().trim().min(1).max(300),
  applicationUrl: z.url({ protocol: /^https?$/ }), facts: ScreeningFactsSchema,
  requirements: ScreeningRequirementsSchema, answers: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), value).superRefine((items, ctx) => {
    if (Object.keys(items).length > 64) ctx.addIssue({ code: 'custom', message: 'Too many answers.' });
  }),
  documents: z.record(z.string().regex(/^[a-z][A-Za-z0-9_-]{0,63}$/), ApplicationDocumentSchema).superRefine((items, ctx) => {
    if (Object.keys(items).length > 16) ctx.addIssue({ code: 'custom', message: 'Too many documents.' });
  }),
  tailoredArtifact: TailoredArtifactSchema.nullable().default(null),
  manifestHash: hash.nullable(), artifactHashes: z.array(hash).max(16), createdAt: timestamp,
});

export type ApplicationContextRequest = z.infer<typeof ApplicationContextRequestSchema>;
export type ScreeningRequirements = z.infer<typeof ScreeningRequirementsSchema>;
export type ApplicationDocument = z.infer<typeof ApplicationDocumentSchema>;
export type ApplicationContext = z.infer<typeof ApplicationContextSchema>;
