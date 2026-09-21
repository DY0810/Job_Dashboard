import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './schema.ts';

export const documents = sqliteTable('private_document', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  kind: text('kind', { enum: ['resume_master', 'resume_source', 'resume_artifact', 'transcript', 'certificate', 'supporting'] }).notNull(),
  name: text('name').notNull(),
  role: text('role'),
  parentId: text('parent_id'),
  masterId: text('master_id').notNull(),
  version: integer('version').notNull(),
  objectKey: text('object_key').notNull().unique(),
  storage: text('storage', { enum: ['local', 'blob'] }).notNull(),
  mime: text('mime').notNull(),
  size: integer('size').notNull(),
  sha256: text('sha256'),
  state: text('state', { enum: ['pending', 'quarantined', 'available', 'rejected', 'expired'] }).notNull().default('pending'),
  safetyCheck: text('safety_check', { enum: ['pending', 'passed', 'rejected', 'deferred'] }).notNull().default('pending'),
  callbackHash: text('callback_hash'),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until'),
  attempts: integer('attempts').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_document_owner_id_unique').on(t.ownerId, t.id),
  uniqueIndex('private_document_master_version_unique').on(t.masterId, t.version),
  index('private_document_owner_state_idx').on(t.ownerId, t.state),
  foreignKey({ columns: [t.ownerId, t.parentId], foreignColumns: [t.ownerId, t.id] }),
  foreignKey({ columns: [t.ownerId, t.masterId], foreignColumns: [t.ownerId, t.id] }),
  check('private_document_kind_check', sql`${t.kind} in ('resume_master','resume_source','resume_artifact','transcript','certificate','supporting')`),
  check('private_document_state_check', sql`${t.state} in ('pending','quarantined','available','rejected','expired')`),
  check('private_document_safety_check', sql`${t.safetyCheck} in ('pending','passed','rejected','deferred')`),
  check('private_document_storage_check', sql`${t.storage} in ('local','blob')`),
  check('private_document_size_check', sql`typeof(${t.size}) = 'integer' and ${t.size} between 1 and 10485760`),
  check('private_document_version_check', sql`typeof(${t.version}) = 'integer' and ${t.version} > 0`),
  check('private_document_attempts_check', sql`typeof(${t.attempts}) = 'integer' and ${t.attempts} >= 0`),
  check('private_document_hash_check', sql`${t.sha256} is null or (length(${t.sha256}) = 64 and ${t.sha256} not glob '*[^a-f0-9]*')`),
  check('private_document_available_check', sql`${t.state} != 'available' or (${t.sha256} is not null and ${t.safetyCheck} = 'passed')`),
  check('private_document_mime_check', sql`${t.mime} in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document')`),
]);

export const documentUploadGrants = sqliteTable('private_document_upload_grant', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  documentId: text('document_id').notNull().unique(),
  requestId: text('request_id').notNull(),
  inputHash: text('input_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),
  tokenIssued: integer('token_issued', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_document_grant_owner_request_unique').on(t.ownerId, t.requestId),
  index('private_document_grant_expiry_idx').on(t.expiresAt),
  foreignKey({ columns: [t.ownerId, t.documentId], foreignColumns: [documents.ownerId, documents.id] }),
  check('private_document_grant_token_check', sql`${t.tokenIssued} in (0,1)`),
]);
