import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './schema.ts';
import { applications } from './worker-schema.ts';
import { documents } from './document-schema.ts';
import type { ApplicationArtifactManifest } from '../applications/artifact-protocol.ts';

export const applicationArtifacts = sqliteTable('private_application_artifact', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id, { onDelete: 'restrict' }),
  applicationId: text('application_id').notNull(),
  requestId: text('request_id').notNull(),
  sourceDocumentId: text('source_document_id').notNull(),
  sourceVersion: integer('source_version').notNull(),
  sourceHash: text('source_hash').notNull(),
  documentId: text('document_id').notNull(),
  outputHash: text('output_hash').notNull(),
  manifestHash: text('manifest_hash').notNull(),
  manifest: text('manifest', { mode: 'json' }).$type<ApplicationArtifactManifest>().notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_artifact_owner_request_unique').on(t.ownerId, t.requestId),
  uniqueIndex('private_artifact_owner_document_unique').on(t.ownerId, t.documentId),
  index('private_artifact_owner_application_idx').on(t.ownerId, t.applicationId, t.createdAt),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  foreignKey({ columns: [t.ownerId, t.sourceDocumentId], foreignColumns: [documents.ownerId, documents.id] }),
  foreignKey({ columns: [t.ownerId, t.documentId], foreignColumns: [documents.ownerId, documents.id] }),
  check('private_artifact_source_version_check', sql`typeof(${t.sourceVersion}) = 'integer' and ${t.sourceVersion} > 0`),
  check('private_artifact_hash_check', sql`length(${t.sourceHash}) = 64 and ${t.sourceHash} not glob '*[^a-f0-9]*' and length(${t.outputHash}) = 64 and ${t.outputHash} not glob '*[^a-f0-9]*' and length(${t.manifestHash}) = 64 and ${t.manifestHash} not glob '*[^a-f0-9]*'`),
  check('private_artifact_manifest_check', sql`json_valid(${t.manifest}) and length(cast(${t.manifest} as blob)) <= 262144`),
]);
