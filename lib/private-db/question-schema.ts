import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { user } from './schema.ts';
import { applications, applicationEvents, workers } from './worker-schema.ts';
import type { AnswerValue, QuestionDescriptor } from '../applications/question-protocol.ts';

export const questionReviews = sqliteTable('private_question_review', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => user.id),
  semanticHash: text('semantic_hash').notNull(), meaningId: text('meaning_id').notNull(), createdAt: integer('created_at').notNull(),
}, t => [uniqueIndex('private_review_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_review_semantic').on(t.ownerId, t.semanticHash),
  check('private_review_hash', sql`length(${t.semanticHash}) = 64`)]);

export const questionAnswers = sqliteTable('private_question_answer', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull().references(() => user.id),
  applicationId: text('application_id').notNull(), questionId: text('question_id').notNull(),
  semanticHash: text('semantic_hash').notNull(), scopeHash: text('scope_hash').notNull(),
  meaningReviewId: text('meaning_review_id'),
  profileRevision: integer('profile_revision').notNull(), policyRevision: integer('policy_revision').notNull(),
  factVersions: text('fact_versions', { mode: 'json' }).$type<{ id: string; version: number }[]>().notNull(),
  reuse: text('reuse', { enum: ['application', 'employer', 'equivalent'] }).notNull(),
  value: text('value', { mode: 'json' }).$type<AnswerValue>().notNull(),
  descriptor: text('descriptor', { mode: 'json' }).$type<QuestionDescriptor>().notNull(),
  provenance: text('provenance', { mode: 'json' }).$type<{ source: 'user'; confirmedAt: number }>().notNull(),
  createdAt: integer('created_at').notNull(),
}, t => [
  uniqueIndex('private_answer_owner_id').on(t.ownerId, t.id),
  index('private_answer_reuse').on(t.ownerId, t.semanticHash, t.profileRevision, t.policyRevision),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  foreignKey({ columns: [t.ownerId, t.meaningReviewId], foreignColumns: [questionReviews.ownerId, questionReviews.id] }),
  check('private_answer_json', sql`json_valid(${t.value}) and json_valid(${t.descriptor}) and json_valid(${t.factVersions}) and json_valid(${t.provenance})`),
  check('private_answer_reuse_check', sql`${t.reuse} in ('application','employer','equivalent') and (${t.reuse} = 'application' or ${t.meaningReviewId} is not null)`),
  check('private_answer_versions', sql`${t.profileRevision} >= 0 and ${t.policyRevision} > 0`),
]);

// Each row is one application's waiter; exact reviewed matches can share an immutable answer.
export const questions = sqliteTable('private_question', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(),
  applicationId: text('application_id').notNull(), key: text('key').notNull(),
  descriptor: text('descriptor', { mode: 'json' }).$type<QuestionDescriptor>().notNull(),
  company: text('company').notNull(), role: text('role').notNull(),
  semanticHash: text('semantic_hash').notNull(), scopeHash: text('scope_hash').notNull(),
  revision: integer('revision').notNull().default(1),
  profileRevision: integer('profile_revision').notNull(), policyRevision: integer('policy_revision').notNull(),
  factVersions: text('fact_versions', { mode: 'json' }).$type<{ id: string; version: number }[]>().notNull(),
  answerId: text('answer_id'), resolvedAt: integer('resolved_at'),
  active: integer('active', { mode: 'boolean' }).notNull().default(true), createdAt: integer('created_at').notNull(),
}, t => [
  uniqueIndex('private_question_owner_id').on(t.ownerId, t.id),
  uniqueIndex('private_question_field').on(t.ownerId, t.applicationId, t.key),
  index('private_question_unresolved').on(t.ownerId, t.active, t.resolvedAt),
  index('private_question_equivalence').on(t.ownerId, t.semanticHash),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  foreignKey({ columns: [t.ownerId, t.answerId], foreignColumns: [questionAnswers.ownerId, questionAnswers.id] }),
  check('private_question_versions', sql`${t.revision} > 0 and ${t.profileRevision} >= 0 and ${t.policyRevision} > 0 and ${t.active} in (0,1)`),
  check('private_question_json', sql`json_valid(${t.descriptor}) and length(cast(${t.descriptor} as blob)) <= 65536 and json_valid(${t.factVersions})`),
]);

export const inboxReads = sqliteTable('private_inbox_read', {
  ownerId: text('owner_id').notNull(), applicationId: text('application_id').notNull(),
  eventId: text('event_id').notNull(), readAt: integer('read_at').notNull(),
}, t => [
  primaryKey({ columns: [t.ownerId, t.applicationId, t.eventId] }),
  foreignKey({ columns: [t.ownerId, t.applicationId, t.eventId], foreignColumns: [applicationEvents.ownerId, applicationEvents.applicationId, applicationEvents.eventId] }),
]);

export const questionInterventions = sqliteTable('private_question_intervention', {
  id: text('id').primaryKey(), ownerId: text('owner_id').notNull(), questionId: text('question_id').notNull(),
  applicationId: text('application_id').notNull(), workerId: text('worker_id').notNull(),
  applicationRevision: integer('application_revision').notNull(), fence: integer('fence').notNull(),
  questionRevision: integer('question_revision').notNull(), revision: integer('revision').notNull().default(1),
  status: text('status', { enum: ['pending', 'focused', 'unavailable', 'observed'] }).notNull().default('pending'),
  reason: text('reason'), createdAt: integer('created_at').notNull(),
}, t => [
  index('private_intervention_worker').on(t.ownerId, t.workerId, t.status),
  foreignKey({ columns: [t.ownerId, t.questionId], foreignColumns: [questions.ownerId, questions.id] }),
  foreignKey({ columns: [t.ownerId, t.applicationId], foreignColumns: [applications.ownerId, applications.id] }),
  foreignKey({ columns: [t.ownerId, t.workerId], foreignColumns: [workers.ownerId, workers.id] }),
  check('private_intervention_state', sql`${t.status} in ('pending','focused','unavailable','observed') and ${t.revision} > 0 and ${t.applicationRevision} > 0 and ${t.fence} > 0`),
]);
