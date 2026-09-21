import { z } from 'zod';
import { ApplicationIdentitySchema, ApplicationSummarySchema } from './worker-protocol.ts';

const uuid = z.uuid();
const timestamp = z.number().int().nonnegative().safe();
const count = z.number().int().nonnegative().safe();
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const postingIds = z.array(z.number().int().positive().safe()).min(1).max(1000)
  .refine((ids) => new Set(ids).size === ids.length, 'Posting IDs must be unique.');
export const IMPORT_PREVIEW_TTL_MS = 30 * 60_000;
export const TARGET_DISPOSITIONS = ['eligible', 'duplicate', 'unresolved', 'held_policy', 'held_cap', 'manual_reported'] as const;
export const ImportPreviewRequestSchema = z.strictObject({ requestId: uuid, postingIds });
export const ImportPreviewRowSchema = z.strictObject({
  postingId: z.number().int().positive().safe(), company: z.string().nullable(), title: z.string().nullable(),
  url: z.string().nullable(), identity: ApplicationIdentitySchema.nullable(),
  resolution: z.enum(['resolved', 'unresolved']), reason: z.string().nullable(),
});
export const ImportPreviewSchema = z.strictObject({
  ownerId: z.string().min(1), previewToken: uuid, previewHash: hash, expiresAt: timestamp,
  rows: z.array(ImportPreviewRowSchema).min(1).max(1000),
});
export const ImportConfirmRequestSchema = z.strictObject({
  requestId: uuid, previewToken: uuid, previewHash: hash, postingIds, confirmOwnership: z.literal(true),
});
export const ImportAcknowledgementSchema = z.strictObject({
  ownerId: z.string().min(1), previewToken: uuid, requestId: uuid, status: z.literal('manual_reported'),
  importedPostingIds: postingIds, resolvedCount: count, unresolvedCount: count,
});
export const DiscoveryStatusSchema = z.strictObject({
  ownerId: z.string().min(1), runId: uuid, state: z.enum(['idle', 'capturing', 'staging', 'ready', 'failed', 'abandoned']),
  lastAttemptAt: timestamp.nullable(), lastScanAt: timestamp.nullable(), errorCode: z.string().nullable(),
  manifestId: uuid.nullable(), manifestHash: hash.nullable(), capturedAt: timestamp.nullable(),
  candidateCount: count, stagedCount: count,
  counts: z.strictObject({
    eligible: count, duplicate: count, unresolved: count, held_policy: count, held_cap: count, manual_reported: count,
  }),
  capAccounting: z.literal('started_per_utc_day'),
});
export const AbandonDiscoverySchema = z.strictObject({ requestId: uuid, manifestId: uuid });
export const AbandonDiscoveryResponseSchema = z.strictObject({ runId: uuid, manifestId: uuid, state: z.literal('abandoned') });
export const DiscoveryErrorSchema = z.strictObject({ error: z.string(), code: z.string().optional() });
export const ReapplyRequestSchema = z.strictObject({
  requestId: uuid, previousApplicationId: uuid, expectedRevision: z.number().int().positive().safe(),
});
export const ReapplyResponseSchema = ApplicationSummarySchema;
export type ImportPreviewRequest = z.infer<typeof ImportPreviewRequestSchema>;
export type ImportPreviewRow = z.infer<typeof ImportPreviewRowSchema>;
export type ImportPreview = z.infer<typeof ImportPreviewSchema>;
export type ImportConfirmRequest = z.infer<typeof ImportConfirmRequestSchema>;
export type ImportAcknowledgement = z.infer<typeof ImportAcknowledgementSchema>;
export type DiscoveryStatus = z.infer<typeof DiscoveryStatusSchema>;
export type TargetDisposition = typeof TARGET_DISPOSITIONS[number];
export type ReapplyRequest = z.infer<typeof ReapplyRequestSchema>;
