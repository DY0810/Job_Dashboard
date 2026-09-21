import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { applications, workers } from './worker-schema.ts';
import { user } from './schema.ts';

const hashCheck = (column: ReturnType<typeof text>) => sql`length(${column}) = 64 and ${column} not glob '*[^a-f0-9]*'`;

export const applicationSubmissions = sqliteTable('private_application_submission', {
  intentId: text('intent_id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  applicationId: text('application_id').notNull(), workerId: text('worker_id').notNull(),
  ats: text('ats').notNull(), tenant: text('tenant').notNull(), requisition: text('requisition').notNull(),
  company: text('company').notNull(), role: text('role').notNull(), manifestHash: text('manifest_hash').notNull(),
  artifactHashes: text('artifact_hashes', { mode: 'json' }).$type<string[]>().notNull(),
  requestHash: text('request_hash').notNull(), state: text('state', { enum: ['intent', 'unknown', 'submitted'] }).notNull().default('intent'),
  createdAt: integer('created_at').notNull(), submittedAt: integer('submitted_at'),
}, (t) => [
  uniqueIndex('private_submission_owner_application').on(t.ownerId, t.applicationId),
  index('private_submission_worker_state').on(t.ownerId, t.workerId, t.state),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  foreignKey({ columns: [t.ownerId, t.workerId], foreignColumns: [workers.ownerId, workers.id] }),
  check('private_submission_manifest_hash', hashCheck(t.manifestHash)),
  check('private_submission_artifacts', sql`json_valid(${t.artifactHashes}) and length(cast(${t.artifactHashes} as blob)) <= 16384`),
  check('private_submission_state', sql`${t.state} in ('intent','unknown','submitted') and (${t.state} != 'submitted' or ${t.submittedAt} is not null)`),
]);

export const applicationReceipts = sqliteTable('private_application_receipt', {
  intentId: text('intent_id').primaryKey(), ownerId: text('owner_id').notNull(), applicationId: text('application_id').notNull(),
  ats: text('ats').notNull(), tenant: text('tenant').notNull(), requisition: text('requisition').notNull(),
  company: text('company').notNull(), role: text('role').notNull(), receiptId: text('receipt_id').notNull(),
  submittedAt: integer('submitted_at').notNull(), evidence: text('evidence', { mode: 'json' }).notNull(), createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_receipt_owner_application').on(t.ownerId, t.applicationId),
  uniqueIndex('private_receipt_owner_receipt').on(t.ownerId, t.ats, t.tenant, t.receiptId),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  foreignKey({ columns: [t.intentId], foreignColumns: [applicationSubmissions.intentId] }),
  check('private_receipt_evidence', sql`json_valid(${t.evidence}) and length(cast(${t.evidence} as blob)) <= 16384`),
]);
