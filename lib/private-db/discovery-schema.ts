import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './schema.ts';
import { applicationRuns, applications } from './worker-schema.ts';
import type { CandidateSnapshot } from '../applications/discovery-source.ts';
import { TARGET_DISPOSITIONS, type ImportPreview, type ImportPreviewRow } from '../applications/discovery-protocol.ts';

export const discoveryManifests = sqliteTable('private_discovery_manifest', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  runId: text('run_id').notNull(),
  policyRevision: integer('policy_revision').notNull(),
  artifact: text('artifact', { mode: 'json' }).$type<CandidateSnapshot>().notNull(),
  hash: text('hash').notNull(),
  capturedAt: integer('captured_at').notNull(),
  candidateCount: integer('candidate_count').notNull(),
  stagedCount: integer('staged_count').notNull().default(0),
  revision: integer('revision').notNull().default(1),
  state: text('state', { enum: ['staging', 'ready', 'abandoned'] }).notNull().default('staging'),
}, (t) => [
  uniqueIndex('private_manifest_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_manifest_owner_run_id').on(t.ownerId, t.runId, t.id),
  foreignKey({ columns: [t.ownerId, t.runId], foreignColumns: [applicationRuns.ownerId, applicationRuns.id] }),
  check('private_manifest_artifact', sql`json_valid(${t.artifact}) and length(cast(${t.artifact} as blob)) <= 16777216 and length(${t.hash}) = 64`),
  check('private_manifest_progress', sql`${t.candidateCount} between 0 and 10000 and ${t.stagedCount} between 0 and ${t.candidateCount} and ${t.revision} > 0 and ${t.state} in ('staging','ready','abandoned') and (${t.state} != 'ready' or ${t.stagedCount} = ${t.candidateCount})`),
]);
export const discoveryTargets = sqliteTable('private_discovery_target', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  runId: text('run_id').notNull(),
  manifestId: text('manifest_id').notNull(),
  targetKey: text('target_key').notNull(),
  candidateIndex: integer('candidate_index').notNull(),
  candidateHash: text('candidate_hash').notNull(),
  ats: text('ats'),
  tenant: text('tenant'),
  requisition: text('requisition'),
  employerKey: text('employer_key'),
  disposition: text('disposition', { enum: TARGET_DISPOSITIONS }).notNull(),
  applicationId: text('application_id'),
}, (t) => [
  uniqueIndex('private_target_run_key').on(t.ownerId, t.runId, t.targetKey),
  index('private_target_manifest').on(t.ownerId, t.manifestId),
  foreignKey({ columns: [t.ownerId, t.runId, t.manifestId], foreignColumns: [discoveryManifests.ownerId, discoveryManifests.runId, discoveryManifests.id] }),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  check('private_target_disposition', sql.raw(`disposition in (${TARGET_DISPOSITIONS.map((value) => `'${value}'`).join(',')})`)),
  check('private_target_identity', sql`(${t.ats} is null and ${t.tenant} is null and ${t.requisition} is null) or (${t.ats} is not null and ${t.tenant} is not null and ${t.requisition} is not null)`),
  check('private_target_snapshot', sql`${t.candidateIndex} >= 0 and length(${t.candidateHash}) = 64`),
]);
export const legacyImportPreviews = sqliteTable('private_legacy_import_preview', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  preview: text('preview', { mode: 'json' }).$type<ImportPreview>().notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
}, (t) => [
  uniqueIndex('private_import_preview_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_import_preview_request').on(t.ownerId, t.requestId),
  check('private_import_preview_json', sql`json_valid(${t.preview}) and length(cast(${t.preview} as blob)) <= 4194304`),
]);
export const manualApplicationMarks = sqliteTable('private_manual_application_mark', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  previewId: text('preview_id').notNull(),
  postingId: integer('posting_id').notNull(),
  evidence: text('evidence', { mode: 'json' }).$type<ImportPreviewRow>().notNull(),
  ats: text('ats'),
  tenant: text('tenant'),
  requisition: text('requisition'),
  status: text('status', { enum: ['manual_reported'] }).notNull().default('manual_reported'),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_manual_preview_posting').on(t.ownerId, t.previewId, t.postingId),
  index('private_manual_identity').on(t.ownerId, t.ats, t.tenant, t.requisition),
  foreignKey({ columns: [t.ownerId, t.previewId], foreignColumns: [legacyImportPreviews.ownerId, legacyImportPreviews.id] }),
  check('private_manual_evidence', sql`json_valid(${t.evidence}) and ${t.status} = 'manual_reported'`),
  check('private_manual_identity_check', sql`(${t.ats} is null and ${t.tenant} is null and ${t.requisition} is null) or (${t.ats} is not null and ${t.tenant} is not null and ${t.requisition} is not null)`),
]);
