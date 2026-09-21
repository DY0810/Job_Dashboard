import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { policyVersions, user } from './schema.ts';
import { APPLICATION_STATES } from '../applications/state.ts';
import type { Checkpoint } from '../applications/worker-protocol.ts';

export const workerPairings = sqliteTable('private_worker_pairing', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  grantHash: text('grant_hash').notNull().unique(),
  credentialBinding: text('credential_binding').notNull(),
  label: text('label').notNull(),
  requestId: text('request_id').notNull(),
  revision: integer('revision').notNull().default(1),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
  revokedAt: integer('revoked_at'),
}, (t) => [
  uniqueIndex('private_pairing_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_pairing_request').on(t.ownerId, t.requestId),
  check('private_pairing_revision', sql`${t.revision} > 0`),
]);
export const workers = sqliteTable('private_worker', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  pairingId: text('pairing_id').notNull().unique(),
  tokenHash: text('token_hash').notNull().unique(),
  credentialBinding: text('credential_binding').notNull(),
  registrationId: text('registration_id').notNull(),
  registrationHash: text('registration_hash').notNull(),
  label: text('label').notNull(),
  protocolVersion: integer('protocol_version').notNull(),
  workerVersion: text('worker_version').notNull(),
  capabilities: text('capabilities', { mode: 'json' }).$type<['control-v1']>().notNull(),
  revision: integer('revision').notNull().default(1),
  createdAt: integer('created_at').notNull(),
  lastSeenAt: integer('last_seen_at'),
  revokedAt: integer('revoked_at'),
}, (t) => [
  uniqueIndex('private_worker_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_worker_registration').on(t.ownerId, t.registrationId),
  foreignKey({ columns: [t.ownerId, t.pairingId], foreignColumns: [workerPairings.ownerId, workerPairings.id] }),
  check('private_worker_protocol', sql`${t.protocolVersion} = 1 and json_valid(${t.capabilities}) and ${t.capabilities} = '["control-v1"]'`),
  check('private_worker_revision', sql`${t.revision} > 0`),
  check('private_worker_hashes', sql`length(${t.tokenHash}) = 64 and length(${t.credentialBinding}) = 64`),
]);
export const applicationRuns = sqliteTable('private_application_run', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  workerId: text('worker_id').notNull(),
  revision: integer('revision').notNull().default(1),
  state: text('state', { enum: ['running', 'paused', 'stopped'] }).notNull().default('running'),
  policyRevision: integer('policy_revision').notNull(),
  policyVersion: integer('policy_version').notNull(),
  policyHash: text('policy_hash').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_run_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_run_assignment').on(t.ownerId, t.id, t.workerId),
  foreignKey({ columns: [t.ownerId, t.workerId], foreignColumns: [workers.ownerId, workers.id] }),
  foreignKey({ columns: [t.ownerId, t.policyVersion], foreignColumns: [policyVersions.ownerId, policyVersions.version] }),
  check('private_run_state', sql`${t.state} in ('running','paused','stopped') and ${t.revision} > 0 and ${t.policyRevision} > 0`),
]);
export const applications = sqliteTable('private_application', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => user.id),
  runId: text('run_id').notNull(),
  workerId: text('worker_id').notNull(),
  ats: text('ats').notNull(),
  tenant: text('tenant').notNull(),
  requisition: text('requisition').notNull(),
  state: text('state', { enum: APPLICATION_STATES }).notNull().default('queued'),
  revision: integer('revision').notNull().default(1),
  fence: integer('fence').notNull().default(0),
  leaseUntil: integer('lease_until'),
  leaseCheckedAt: integer('lease_checked_at'),
  checkpoint: text('checkpoint', { mode: 'json' }).$type<Checkpoint>(),
  reasonCode: text('reason_code'),
  retries: integer('retries').notNull().default(0),
  availableAt: integer('available_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  uniqueIndex('private_application_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_application_identity').on(t.ownerId, t.ats, t.tenant, t.requisition),
  uniqueIndex('private_application_active_tenant').on(t.ownerId, t.ats, t.tenant).where(sql`${t.leaseUntil} is not null`),
  index('private_application_queue').on(t.ownerId, t.workerId, t.availableAt),
  foreignKey({ columns: [t.ownerId, t.runId, t.workerId], foreignColumns: [applicationRuns.ownerId, applicationRuns.id, applicationRuns.workerId] }),
  check('private_application_state', sql.raw(`state in (${APPLICATION_STATES.map((s) => `'${s}'`).join(',')})`)),
  check('private_application_counters', sql`${t.revision} > 0 and ${t.fence} >= 0 and ${t.retries} between 0 and 3`),
  check('private_application_lease', sql`(${t.leaseUntil} is null and ${t.leaseCheckedAt} is null) or (${t.leaseUntil} is not null and ${t.leaseCheckedAt} is not null and ${t.fence} > 0 and ${t.leaseUntil} > ${t.leaseCheckedAt} and ${t.state} in ('screening','tailoring','filling','ready','submitting','submission_unknown'))`),
  check('private_application_checkpoint', sql`${t.checkpoint} is null or (json_valid(${t.checkpoint}) and length(${t.checkpoint}) <= 1024)`),
]);
export const applicationEvents = sqliteTable('private_application_event', {
  ownerId: text('owner_id').notNull(),
  applicationId: text('application_id').notNull(),
  eventId: text('event_id').notNull(),
  requestHash: text('request_hash').notNull(),
  acknowledgement: text('acknowledgement', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.applicationId, t.eventId] }),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  check('private_application_event_json', sql`json_valid(${t.acknowledgement})`),
]);
export const workerCommands = sqliteTable('private_worker_command', {
  ownerId: text('owner_id').notNull().references(() => user.id),
  requestId: text('request_id').notNull(),
  requestHash: text('request_hash').notNull(),
  acknowledgement: text('acknowledgement', { mode: 'json' }).notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [
  primaryKey({ columns: [t.ownerId, t.requestId] }),
  check('private_worker_command_json', sql`json_valid(${t.acknowledgement})`),
]);
