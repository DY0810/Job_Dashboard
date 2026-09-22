import 'server-only';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import {
  applications, applicationEvents, documents, inboxReads, questionAnswers, questionInterventions,
  questionReviews, questions, workers, workerPairings,
} from '../private-db/schema.ts';
import { getPolicy, getProfile, hashValue } from './stores.ts';
import { checkedLease } from './leases.ts';
import { isWaitingState } from './state.ts';
import {
  appScope, credentialBinding, fail, liveRun, nowAt, one, randomUUID, replayCommand, saveCommand,
  withWorker, workerTransaction, WorkerError, type ApplicationRow, type WorkerOptions, type WorkerTx,
} from './worker-store.ts';
import {
  AnswerCommandSchema, FocusCommandSchema, InboxQuerySchema, QuestionBatchSchema, QuestionDetailSchema,
  ReadCommandSchema, ReviewCommandSchema, InterventionAckSchema, validQuestionAnswer,
  type AnswerCommand, type AnswerResult, type AnswerValue, type FocusCommand, type FocusResult,
  type InboxPage, type InboxStatus, type QuestionBatch, type QuestionBatchResult, type QuestionDescriptor,
  type QuestionDetail, type ReadCommand, type ReviewCommand, type InterventionAck, type InterventionPage,
} from './question-protocol.ts';

type QuestionRow = typeof questions.$inferSelect;
type AnswerRow = typeof questionAnswers.$inferSelect;
type Context = Awaited<ReturnType<typeof context>>;
const INTERVENTION_PAGE_BYTES = 120 * 1024;
const qScope = (ownerId: string, id: string) => and(eq(questions.ownerId, ownerId), eq(questions.id, id));
const unsent = ['queued', 'screening', 'tailoring', 'filling', 'ready', 'needs_answer', 'needs_document',
  'needs_policy_decision', 'needs_login', 'needs_verification', 'provider_unavailable'];

async function context(tx: WorkerTx, ownerId: string, options: WorkerOptions) {
  const now = nowAt(options), profile = await getProfile(tx, ownerId), policy = await getPolicy(tx, ownerId, now);
  const facts = new Map<string, number>();
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if ('state' in item) {
      if (typeof item.id === 'string' && typeof item.version === 'number') facts.set(item.id, item.version);
      return;
    }
    Object.values(item).forEach(visit);
  }
  visit(profile.profile);
  return { ownerId, now, profile, policy, facts, options };
}
function factVersions(q: QuestionDescriptor, ctx: Context) {
  return [...q.factIds].sort().map(id => ({ id, version: ctx.facts.get(id) ?? 0 }));
}
function semanticHash(q: QuestionDescriptor) {
  // Transport tenant is not an applicant/country fact. Employer and application scopes retain it.
  const scope = { ...q.scope, tenant: ['applicant', 'country'].includes(q.scope.kind) ? null : q.scope.tenant };
  return hashValue({ wording: q.originalWording, meaning: q.meaning.id, kind: q.kind, required: q.required,
    schemaVersion: q.schemaVersion, field: q.field, scope, sensitive: q.sensitive, factIds: [...q.factIds].sort() });
}
function currentTimeframe(q: QuestionDescriptor, now: number) {
  const { timeframe, validFrom, validUntil } = q.scope, today = new Date(now).toISOString().slice(0, 10);
  if (timeframe === 'historical' || timeframe === 'ever') return true;
  const expired = validUntil && today.slice(0, validUntil.value.length) > validUntil.value;
  const notStarted = timeframe === 'current' && validFrom && today.slice(0, validFrom.value.length) < validFrom.value;
  return !expired && !notStarted;
}
function currentDescriptor(row: QuestionRow, ctx: Context) {
  const facts = factVersions(row.descriptor, ctx);
  return row.active && row.policyRevision === ctx.policy.revision && facts.every(f => f.version > 0) &&
    row.scopeHash === hashValue(row.descriptor.scope) && row.semanticHash === semanticHash(row.descriptor) &&
    currentTimeframe(row.descriptor, ctx.now);
}
function fresh(row: QuestionRow, ctx: Context) {
  return currentDescriptor(row, ctx) && row.profileRevision === ctx.profile.revision &&
    hashValue(factVersions(row.descriptor, ctx)) === hashValue(row.factVersions);
}
async function workerAvailable(tx: WorkerTx, app: ApplicationRow, ctx: Context) {
  const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ctx.ownerId), eq(workers.id, app.workerId)));
  if (!worker || worker.revokedAt !== null) return false;
  const [pairing] = await tx.select().from(workerPairings).where(and(
    eq(workerPairings.ownerId, ctx.ownerId), eq(workerPairings.id, worker.pairingId),
  ));
  if (!pairing || pairing.revokedAt !== null) return false;
  const binding = await credentialBinding(tx, ctx.ownerId, ctx.options);
  return binding !== null && worker.credentialBinding === binding && pairing.credentialBinding === binding;
}
async function eligible(tx: WorkerTx, app: ApplicationRow, ctx: Context) {
  if (isWaitingState(app.state) && app.reasonCode === 'run_paused') {
    // Pause replaces reasonCode; recover the blocker authority from immutable revisioned events.
    const [last] = await tx.select({ ack: applicationEvents.acknowledgement }).from(applicationEvents).where(and(
      eq(applicationEvents.ownerId, ctx.ownerId), eq(applicationEvents.applicationId, app.id),
      sql`(json_extract(${applicationEvents.acknowledgement}, '$.questionIds') is not null
        or json_extract(${applicationEvents.acknowledgement}, '$.state') is not null)`,
    )).orderBy(desc(sql`json_extract(${applicationEvents.acknowledgement}, '$.revision')`)).limit(1);
    if (!last || !Array.isArray((last.ack as { questionIds?: unknown }).questionIds)) return false;
  }
  return app.ownerId === ctx.ownerId && unsent.includes(app.state) && ctx.policy.enabled &&
    (!isWaitingState(app.state) || app.reasonCode === 'question_unresolved' || app.reasonCode === 'run_paused') &&
    await liveRun(tx, app, ctx.now) && await workerAvailable(tx, app, ctx);
}
const documentPermission = (kind: typeof documents.$inferSelect['kind']) =>
  kind === 'resume_master' || kind === 'resume_source' || kind === 'resume_artifact' ? 'resume' :
    kind === 'portfolio' || kind === 'artwork' ? 'portfolio' : kind === 'supporting' ? null : kind;
function permitted(q: QuestionDescriptor, ctx: Context) {
  if (!ctx.policy.policy.actions.includes('fill_forms') || q.field.type === 'intervention') return false;
  if (q.field.type === 'document') return q.field.documentKinds.some(kind => {
    const permission = documentPermission(kind);
    return permission !== null && ctx.policy.policy.documentKinds.includes(permission);
  });
  return true;
}
const allowOptional = (q: QuestionDescriptor, ctx: Context) =>
  !q.sensitive || ctx.policy.policy.disclosure === 'confirmed_only';
async function canAnswer(tx: WorkerTx, row: QuestionRow, app: ApplicationRow, ctx: Context) {
  return currentDescriptor(row, ctx) && permitted(row.descriptor, ctx) && await eligible(tx, app, ctx);
}
async function ownedQuestion(tx: WorkerTx, ownerId: string, id: string) {
  const [row] = await tx.select().from(questions).where(qScope(ownerId, id));
  if (!row) fail(404, 'NOT_FOUND', 'Question not found.');
  const [app] = await tx.select().from(applications).where(appScope(ownerId, row.applicationId));
  if (!app) fail(404, 'NOT_FOUND', 'Question not found.');
  return { row, app };
}
async function reviewedMeaning(tx: WorkerTx, row: Pick<QuestionRow, 'ownerId' | 'semanticHash'>) {
  const [review] = await tx.select().from(questionReviews).where(and(
    eq(questionReviews.ownerId, row.ownerId), eq(questionReviews.semanticHash, row.semanticHash),
  ));
  return review;
}
function reuseScopes(q: QuestionDescriptor, reviewed: boolean, ctx: Context): AnswerCommand['reuse'][] {
  const result: AnswerCommand['reuse'][] = ['application'];
  if (!reviewed || q.scope.kind === 'application' || (q.sensitive && ctx.policy.policy.disclosure === 'ask_each_sensitive')) return result;
  result.push('employer', 'equivalent');
  return result;
}
function scopeMatches(answer: Pick<AnswerRow, 'reuse' | 'applicationId' | 'descriptor'>, row: QuestionRow) {
  if (answer.reuse === 'application') return answer.applicationId === row.applicationId;
  if (answer.reuse === 'employer') return answer.descriptor.scope.ats === row.descriptor.scope.ats &&
    answer.descriptor.scope.tenant === row.descriptor.scope.tenant;
  return true; // The exact semantic hash still contains scope kind, timeframe and any scoped employer/application.
}
async function answerValid(tx: WorkerTx, row: QuestionRow, value: AnswerValue, ctx: Context) {
  if (!validQuestionAnswer(row.descriptor, value, allowOptional(row.descriptor, ctx))) return false;
  if (value.type !== 'document') return true;
  const field = row.descriptor.field;
  if (field.type !== 'document') return false;
  const [document] = await tx.select().from(documents).where(and(
    eq(documents.ownerId, ctx.ownerId), eq(documents.id, value.documentId), eq(documents.version, value.version),
    eq(documents.sha256, value.sha256), eq(documents.state, 'available'), eq(documents.safetyCheck, 'passed'),
  ));
  if (!document) return false;
  const permission = documentPermission(document.kind);
  const fieldKinds = document.kind === 'resume_artifact' ? ['resume_master', 'resume_source'] : [document.kind];
  return permission !== null && ctx.policy.policy.documentKinds.includes(permission) &&
    fieldKinds.some((kind) => field.documentKinds.includes(kind as typeof field.documentKinds[number])) &&
    field.mimeTypes.includes(document.mime as typeof field.mimeTypes[number]) &&
    document.size <= field.maxBytes;
}
const focusResult = (row: typeof questionInterventions.$inferSelect): FocusResult => ({
  id: row.id, questionId: row.questionId, applicationId: row.applicationId, workerId: row.workerId,
  revision: row.revision, status: row.status, reason: row.reason,
});

async function detail(tx: WorkerTx, row: QuestionRow, app: ApplicationRow, ctx: Context): Promise<QuestionDetail> {
  const available = await canAnswer(tx, row, app, ctx), review = await reviewedMeaning(tx, row);
  const [focus] = await tx.select().from(questionInterventions).where(and(
    eq(questionInterventions.ownerId, ctx.ownerId), eq(questionInterventions.questionId, row.id),
  )).orderBy(desc(questionInterventions.createdAt), desc(questionInterventions.id)).limit(1);
  const matches = await tx.select({ question: questions, app: applications }).from(questions)
    .innerJoin(applications, and(eq(applications.ownerId, questions.ownerId), eq(applications.id, questions.applicationId)))
    .where(and(eq(questions.ownerId, ctx.ownerId), eq(questions.semanticHash, row.semanticHash),
      eq(questions.active, true), isNull(questions.resolvedAt)));
  const waiting = new Set<string>();
  for (const match of matches) {
    if (fresh(match.question, ctx) && (unsent.includes(match.app.state) || isWaitingState(match.app.state)) &&
        (review || match.question.id === row.id)) waiting.add(match.app.id);
  }
  return QuestionDetailSchema.parse({
    id: row.id, ownerId: ctx.ownerId, revision: row.revision,
    descriptor: { ...row.descriptor, meaning: { ...row.descriptor.meaning, reviewId: review?.id ?? null } },
    application: { id: app.id, workerId: app.workerId, ats: app.ats, tenant: app.tenant, requisition: app.requisition,
      company: row.company, role: row.role },
    waitingCount: waiting.size, resolved: row.resolvedAt !== null, expectedProfileRevision: ctx.profile.revision,
    expectedPolicyRevision: ctx.policy.revision || row.policyRevision, expectedScopeHash: row.scopeHash,
    factVersions: factVersions(row.descriptor, ctx).filter(f => f.version > 0),
    allowedReuse: available ? reuseScopes(row.descriptor, !!review, ctx) : [],
    canAnswer: available, canBlank: available && !row.descriptor.required && row.descriptor.field.allowBlank && allowOptional(row.descriptor, ctx),
    canDecline: available && row.descriptor.field.declineValue !== null && allowOptional(row.descriptor, ctx),
    focus: focus ? focusResult(focus) : null,
  });
}
export async function getQuestion(db: PrivateDb, ownerId: string, id: string, options: WorkerOptions = {}): Promise<QuestionDetail> {
  return workerTransaction(db, async tx => {
    const { row, app } = await ownedQuestion(tx, ownerId, id);
    return detail(tx, row, app, await context(tx, ownerId, options));
  });
}

async function notify(tx: WorkerTx, app: ApplicationRow, kind: string, questionId: string | null, now: number) {
  const acknowledgement = { kind, questionId };
  one(await tx.insert(applicationEvents).values({ ownerId: app.ownerId, applicationId: app.id, eventId: randomUUID(),
    requestHash: hashValue(acknowledgement), acknowledgement, createdAt: now }).returning({ eventId: applicationEvents.eventId }));
}
// Batch and ordinary checkpoint acknowledgements are not notifications. Terminal receipts stay questionless.
const notification = sql`(json_extract(${applicationEvents.acknowledgement}, '$.kind') is not null
  or json_extract(${applicationEvents.acknowledgement}, '$.state') in ('submitted','failed'))`;
const readJoin = and(eq(inboxReads.ownerId, applicationEvents.ownerId),
  eq(inboxReads.applicationId, applicationEvents.applicationId), eq(inboxReads.eventId, applicationEvents.eventId));
async function inboxStatus(tx: WorkerTx, ownerId: string, now: number): Promise<InboxStatus> {
  const [unread] = await tx.select({ count: sql<number>`count(*)` }).from(applicationEvents)
    .leftJoin(inboxReads, readJoin).where(and(eq(applicationEvents.ownerId, ownerId), notification, isNull(inboxReads.eventId)));
  const [unresolved] = await tx.select({ count: sql<number>`count(*)`, applications: sql<number>`count(distinct ${questions.applicationId})` })
    .from(questions).innerJoin(applications, and(eq(applications.ownerId, questions.ownerId), eq(applications.id, questions.applicationId)))
    .where(and(eq(questions.ownerId, ownerId), eq(questions.active, true), isNull(questions.resolvedAt),
      inArray(applications.state, [...unsent, 'retryable_failure', 'blocked_unsupported'] as ApplicationRow['state'][])));
  return { ownerId, unread: unread.count, unresolved: unresolved.count, waitingApplications: unresolved.applications, serverTime: now };
}
export async function getInboxStatus(db: PrivateDb, ownerId: string, options: WorkerOptions = {}): Promise<InboxStatus> {
  return workerTransaction(db, tx => inboxStatus(tx, ownerId, nowAt(options)));
}
export async function getInbox(
  db: PrivateDb, ownerId: string, input: { limit?: number; cursor?: string } = {}, options: WorkerOptions = {},
): Promise<InboxPage> {
  const query = InboxQuerySchema.parse(input);
  return workerTransaction(db, async tx => {
    const ctx = await context(tx, ownerId, options);
    let cursor: typeof applicationEvents.$inferSelect | undefined;
    if (query.cursor) {
      const rows = await tx.select().from(applicationEvents).where(and(
        eq(applicationEvents.ownerId, ownerId), eq(applicationEvents.eventId, query.cursor), notification,
      ));
      if (!rows.length) fail(404, 'NOT_FOUND', 'Inbox cursor not found.');
      cursor = one(rows);
    }
    const rows = await tx.select({ event: applicationEvents, read: inboxReads.eventId }).from(applicationEvents)
      .leftJoin(inboxReads, readJoin).where(and(eq(applicationEvents.ownerId, ownerId), notification,
        cursor && sql`(${applicationEvents.createdAt}, ${applicationEvents.eventId}, ${applicationEvents.applicationId})
          < (${cursor.createdAt}, ${cursor.eventId}, ${cursor.applicationId})`))
      .orderBy(desc(applicationEvents.createdAt), desc(applicationEvents.eventId), desc(applicationEvents.applicationId)).limit(query.limit + 1);
    const items: InboxPage['items'] = [];
    for (const { event, read } of rows.slice(0, query.limit)) {
      const ack = event.acknowledgement as { kind?: string; state?: string; questionId?: string };
      let question: QuestionDetail | null = null;
      if (ack.questionId) {
        const owned = await ownedQuestion(tx, ownerId, ack.questionId);
        if (owned.app.id !== event.applicationId) fail();
        question = await detail(tx, owned.row, owned.app, ctx);
      }
      items.push({ eventId: event.eventId, applicationId: event.applicationId, kind: ack.kind ?? ack.state!,
        createdAt: event.createdAt, read: read !== null, question });
    }
    return { ...await inboxStatus(tx, ownerId, ctx.now), items,
      nextCursor: rows.length > query.limit ? items[items.length - 1].eventId : null };
  });
}
export async function markInboxRead(db: PrivateDb, ownerId: string, input: ReadCommand): Promise<{ ownerId: string; eventIds: string[] }> {
  const command = ReadCommandSchema.parse(input);
  return workerTransaction(db, async tx => {
    for (const eventId of new Set(command.eventIds)) {
      const rows = await tx.select().from(applicationEvents).where(and(
        eq(applicationEvents.ownerId, ownerId), eq(applicationEvents.eventId, eventId), notification,
      ));
      if (!rows.length) fail(404, 'NOT_FOUND', 'Notification not found.');
      const event = one(rows);
      await tx.insert(inboxReads).values({ ownerId, applicationId: event.applicationId, eventId, readAt: Date.now() }).onConflictDoNothing();
      const [receipt] = await tx.select().from(inboxReads).where(and(eq(inboxReads.ownerId, ownerId),
        eq(inboxReads.applicationId, event.applicationId), eq(inboxReads.eventId, eventId)));
      if (!receipt) fail();
    }
    return { ownerId, eventIds: command.eventIds };
  });
}

export async function reviewQuestion(db: PrivateDb, ownerId: string, id: string, input: ReviewCommand, options: WorkerOptions = {}): Promise<QuestionDetail> {
  const command = ReviewCommandSchema.parse(input), scope = `question:review:${id}`;
  return workerTransaction(db, async tx => {
    const { row, app } = await ownedQuestion(tx, ownerId, id);
    const replay = await replayCommand<QuestionDetail>(tx, ownerId, scope, command);
    if (replay) return replay;
    const ctx = await context(tx, ownerId, options);
    const facts = factVersions(row.descriptor, ctx);
    if (command.expectedRevision !== row.revision || command.meaningId !== row.descriptor.meaning.id ||
        command.expectedProfileRevision !== ctx.profile.revision || command.expectedPolicyRevision !== ctx.policy.revision ||
        command.expectedScopeHash !== row.scopeHash || hashValue(command.factVersions) !== hashValue(facts) ||
        !currentDescriptor(row, ctx) || !ctx.policy.policy.actions.includes('fill_forms') || !await eligible(tx, app, ctx)) fail();
    let review = await reviewedMeaning(tx, row);
    if (!review) review = one(await tx.insert(questionReviews).values({
      id: randomUUID(), ownerId, semanticHash: row.semanticHash, meaningId: command.meaningId, createdAt: ctx.now,
    }).returning());
    const invalidate = !fresh(row, ctx) && row.resolvedAt !== null;
    const updated = one(await tx.update(questions).set({
      descriptor: { ...row.descriptor, meaning: { id: command.meaningId, reviewId: review.id } }, revision: row.revision + 1,
      profileRevision: ctx.profile.revision, factVersions: facts,
      ...(invalidate ? { answerId: null, resolvedAt: null } : {}),
    }).where(and(qScope(ownerId, id), eq(questions.revision, row.revision))).returning());
    if (invalidate) await reschedule(tx, app, ctx);
    const result = await detail(tx, updated, app, ctx);
    await saveCommand(tx, ownerId, scope, command, result, ctx.now);
    return result;
  });
}

async function reschedule(tx: WorkerTx, app: ApplicationRow, ctx: Context): Promise<boolean> {
  if (!await eligible(tx, app, ctx)) fail();
  const rows = await tx.select().from(questions).where(and(eq(questions.ownerId, ctx.ownerId),
    eq(questions.applicationId, app.id), eq(questions.active, true))).orderBy(questions.createdAt, questions.id);
  const blocker = rows.find(q => q.resolvedAt === null || !fresh(q, ctx));
  const state = blocker ? (blocker.descriptor.kind === 'failed' ? 'blocked_unsupported' :
    blocker.resolvedAt !== null ? 'needs_answer' : blocker.descriptor.kind) : 'screening';
  const updated = one(await tx.update(applications).set({ state, revision: app.revision + 1, fence: app.fence + 1,
    leaseUntil: null, leaseCheckedAt: null, checkpoint: { stage: 'screening', sequence: (app.checkpoint?.sequence ?? 0) + 1 },
    reasonCode: blocker ? 'question_unresolved' : null, availableAt: ctx.now,
  }).where(and(appScope(ctx.ownerId, app.id), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
  if (!blocker) await notify(tx, updated, 'question_resumed', null, ctx.now);
  return !blocker;
}

export async function answerQuestion(db: PrivateDb, ownerId: string, id: string, input: AnswerCommand, options: WorkerOptions = {}): Promise<AnswerResult> {
  const command = AnswerCommandSchema.parse(input), scope = `question:answer:${id}`;
  return workerTransaction(db, async tx => {
    const { row, app } = await ownedQuestion(tx, ownerId, id);
    const replay = await replayCommand<AnswerResult>(tx, ownerId, scope, command);
    if (replay) return { ...replay, replayed: true };
    const ctx = await context(tx, ownerId, options), review = await reviewedMeaning(tx, row), facts = factVersions(row.descriptor, ctx);
    if (command.expectedRevision !== row.revision || command.expectedProfileRevision !== ctx.profile.revision ||
        command.expectedPolicyRevision !== ctx.policy.revision || command.expectedScopeHash !== row.scopeHash ||
        hashValue(command.factVersions) !== hashValue(facts) || !await canAnswer(tx, row, app, ctx) ||
        !reuseScopes(row.descriptor, !!review, ctx).includes(command.reuse) || !await answerValid(tx, row, command.answer, ctx)) fail();
    const answer = one(await tx.insert(questionAnswers).values({
      id: randomUUID(), ownerId, applicationId: app.id, questionId: row.id, semanticHash: row.semanticHash, scopeHash: row.scopeHash,
      meaningReviewId: review?.id ?? null, profileRevision: ctx.profile.revision, policyRevision: ctx.policy.revision,
      factVersions: facts, reuse: command.reuse, value: command.answer, descriptor: row.descriptor,
      provenance: { source: 'user', confirmedAt: ctx.now }, createdAt: ctx.now,
    }).returning());
    const candidates = await tx.select({ question: questions, app: applications }).from(questions)
      .innerJoin(applications, and(eq(applications.ownerId, questions.ownerId), eq(applications.id, questions.applicationId)))
      .where(and(eq(questions.ownerId, ownerId), eq(questions.semanticHash, row.semanticHash), eq(questions.active, true)))
      .orderBy(questions.createdAt, questions.id);
    const resolvedQuestionIds: string[] = [], changedApps = new Map<string, ApplicationRow>();
    for (const candidate of candidates) {
      if (!scopeMatches(answer, candidate.question) || !await canAnswer(tx, candidate.question, candidate.app, ctx)) continue;
      one(await tx.update(questions).set({ answerId: answer.id, resolvedAt: ctx.now, revision: candidate.question.revision + 1,
        profileRevision: ctx.profile.revision, factVersions: facts })
        .where(and(qScope(ownerId, candidate.question.id), eq(questions.revision, candidate.question.revision))).returning());
      resolvedQuestionIds.push(candidate.question.id); changedApps.set(candidate.app.id, candidate.app);
    }
    if (!resolvedQuestionIds.includes(id)) fail();
    const resumedApplicationIds: string[] = [];
    for (const app of changedApps.values()) if (await reschedule(tx, app, ctx)) resumedApplicationIds.push(app.id);
    const result: AnswerResult = { ownerId, answerId: answer.id, questionId: id, resolvedQuestionIds, resumedApplicationIds, replayed: false };
    await saveCommand(tx, ownerId, scope, command, result, ctx.now);
    return result;
  });
}

async function reusableAnswer(tx: WorkerTx, row: QuestionRow, app: ApplicationRow, ctx: Context) {
  if (!fresh(row, ctx) || !await canAnswer(tx, row, app, ctx)) return;
  const review = await reviewedMeaning(tx, row);
  // rowid breaks same-millisecond ties by committed insertion order, not random UUID order.
  const answers = await tx.select().from(questionAnswers).where(and(eq(questionAnswers.ownerId, ctx.ownerId),
    eq(questionAnswers.semanticHash, row.semanticHash))).orderBy(desc(sql`rowid`));
  for (const answer of answers) {
    if (!scopeMatches(answer, row)) continue;
    if (answer.reuse !== 'application' && (!review || answer.meaningReviewId !== review.id ||
        !reuseScopes(row.descriptor, true, ctx).includes(answer.reuse))) continue;
    if (answer.profileRevision !== ctx.profile.revision || answer.policyRevision !== ctx.policy.revision ||
        hashValue(answer.factVersions) !== hashValue(row.factVersions) || !await answerValid(tx, row, answer.value, ctx)) return;
    return answer;
  }
}

export async function registerQuestionBatch(
  db: PrivateDb, token: string, applicationId: string, input: QuestionBatch, options: WorkerOptions = {},
): Promise<QuestionBatchResult> {
  const command = QuestionBatchSchema.parse(input);
  if (Buffer.byteLength(JSON.stringify(command)) > 128 * 1024) fail(413, 'INVALID_INPUT', 'Question batch is too large.');
  return withWorker<QuestionBatchResult>(db, token, options, async (tx, worker, now) => {
    const [owned] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    if (!owned) fail(404, 'NOT_FOUND', 'Application not found.');
    const requestHash = hashValue(['question:batch', command]);
    const [previous] = await tx.select().from(applicationEvents).where(and(eq(applicationEvents.ownerId, worker.ownerId),
      eq(applicationEvents.applicationId, applicationId), eq(applicationEvents.eventId, command.eventId)));
    if (previous) {
      if (previous.requestHash !== requestHash) fail();
      return { ...previous.acknowledgement as QuestionBatchResult, replayed: true, lease: null };
    }
    const app = await checkedLease(tx, worker, { applicationId, expectedRevision: command.expectedRevision, fence: command.fence }, now);
    if (app instanceof WorkerError) return app;
    if (!['screening', 'tailoring', 'filling', 'ready'].includes(app.state) ||
        command.checkpoint.stage !== app.state || command.checkpoint.sequence !== (app.checkpoint?.sequence ?? 0) + 1) fail();
    const ctx = await context(tx, worker.ownerId, options);
    if (command.expectedProfileRevision !== ctx.profile.revision) fail();
    const questionIds: string[] = [];
    for (const descriptor of command.questions) {
      const facts = factVersions(descriptor, ctx), semantic = semanticHash(descriptor);
      if (descriptor.scope.ats !== app.ats || descriptor.scope.tenant !== app.tenant ||
          (descriptor.scope.applicationId !== null && descriptor.scope.applicationId !== app.id) ||
          facts.some(f => f.version === 0)) fail();
      const review = await reviewedMeaning(tx, { ownerId: worker.ownerId, semanticHash: semantic });
      if (descriptor.meaning.reviewId && descriptor.meaning.reviewId !== review?.id) fail();
      const values = {
        descriptor: { ...descriptor, meaning: { ...descriptor.meaning, reviewId: review?.id ?? null } },
        company: command.company, role: command.role, semanticHash: semantic, scopeHash: hashValue(descriptor.scope),
        profileRevision: ctx.profile.revision, policyRevision: ctx.policy.revision, factVersions: facts,
      };
      if (Buffer.byteLength(JSON.stringify(values.descriptor)) > 64 * 1024)
        fail(413, 'INVALID_INPUT', 'Question descriptor exceeds its stored byte limit.');
      const [old] = await tx.select().from(questions).where(and(eq(questions.ownerId, worker.ownerId),
        eq(questions.applicationId, applicationId), eq(questions.key, descriptor.key)));
      const changed = !old || old.semanticHash !== semantic || old.scopeHash !== values.scopeHash || !fresh(old, ctx);
      let row: QuestionRow;
      if (old && !changed) row = old;
      else if (old) row = one(await tx.update(questions).set({ ...values, active: true, answerId: null, resolvedAt: null, revision: old.revision + 1 })
        .where(and(qScope(worker.ownerId, old.id), eq(questions.revision, old.revision))).returning());
      else row = one(await tx.insert(questions).values({ ...values, id: randomUUID(), ownerId: worker.ownerId,
        applicationId, key: descriptor.key, createdAt: now }).returning());
      const reusable = await reusableAnswer(tx, row, app, ctx);
      const optional = !descriptor.required && (descriptor.field.allowBlank || descriptor.field.declineValue !== null) &&
        allowOptional(descriptor, ctx) && await canAnswer(tx, row, app, ctx);
      if (reusable || optional) {
        if (row.resolvedAt === null || (reusable && row.answerId !== reusable.id))
          row = one(await tx.update(questions).set({ answerId: reusable?.id ?? null, resolvedAt: now, revision: row.revision + 1 })
            .where(and(qScope(worker.ownerId, row.id), eq(questions.revision, row.revision))).returning());
      }
      if (row.resolvedAt === null && changed) await notify(tx, app, descriptor.kind, row.id, now);
      questionIds.push(row.id);
    }
    // Omitted fields remain active. A partial batch cannot silently erase another blocker.
    const rows = await tx.select().from(questions).where(and(eq(questions.ownerId, worker.ownerId),
      eq(questions.applicationId, applicationId), eq(questions.active, true))).orderBy(questions.createdAt, questions.id);
    const blocker = rows.find(q => q.resolvedAt === null || !fresh(q, ctx));
    const state = blocker ? (blocker.descriptor.kind === 'failed' ? 'blocked_unsupported' :
      blocker.resolvedAt !== null ? 'needs_answer' : blocker.descriptor.kind) : 'screening';
    const updated = one(await tx.update(applications).set({ state, revision: app.revision + 1, fence: app.fence + 1,
      leaseUntil: null, leaseCheckedAt: null, checkpoint: blocker ? command.checkpoint : { ...command.checkpoint, stage: 'screening' },
      reasonCode: blocker ? 'question_unresolved' : null, availableAt: now,
    }).where(and(appScope(worker.ownerId, applicationId), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
    const result: QuestionBatchResult = { applicationId, eventId: command.eventId, revision: updated.revision, questionIds, replayed: false, lease: null };
    one(await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId, eventId: command.eventId,
      requestHash, acknowledgement: result, createdAt: now }).returning({ eventId: applicationEvents.eventId }));
    return result;
  });
}

export async function requestQuestionFocus(
  db: PrivateDb, ownerId: string, id: string, input: FocusCommand, options: WorkerOptions = {},
): Promise<FocusResult> {
  const command = FocusCommandSchema.parse(input), scope = `question:focus:${id}`;
  return workerTransaction(db, async tx => {
    const { row, app } = await ownedQuestion(tx, ownerId, id);
    const replay = await replayCommand<FocusResult>(tx, ownerId, scope, command);
    if (replay) return replay;
    const ctx = await context(tx, ownerId, options);
    if (command.expectedRevision !== row.revision || row.resolvedAt !== null || !fresh(row, ctx) ||
        !['needs_login', 'needs_verification'].includes(row.descriptor.kind) ||
        !ctx.policy.policy.actions.includes('fill_forms') || !await eligible(tx, app, ctx)) fail();
    const pending = one(await tx.insert(questionInterventions).values({ id: randomUUID(), ownerId, questionId: id,
      applicationId: app.id, workerId: app.workerId, applicationRevision: app.revision, fence: app.fence,
      questionRevision: row.revision, createdAt: ctx.now }).returning());
    const result = focusResult(pending);
    await saveCommand(tx, ownerId, scope, command, result, ctx.now);
    return result;
  });
}

async function currentIntervention(
  tx: WorkerTx, intervention: typeof questionInterventions.$inferSelect, row: QuestionRow,
  app: ApplicationRow, workerId: string, ctx: Context,
) {
  return intervention.ownerId === ctx.ownerId && intervention.workerId === workerId && app.workerId === workerId &&
    intervention.applicationId === app.id && row.applicationId === app.id && intervention.questionId === row.id &&
    intervention.questionRevision === row.revision && intervention.applicationRevision === app.revision &&
    intervention.fence === app.fence && ['pending', 'focused'].includes(intervention.status) &&
    row.resolvedAt === null && ['needs_login', 'needs_verification'].includes(row.descriptor.kind) &&
    ctx.policy.policy.actions.includes('fill_forms') && fresh(row, ctx) && await eligible(tx, app, ctx);
}

export async function pollQuestionInterventions(
  db: PrivateDb, token: string, options: WorkerOptions = {},
): Promise<InterventionPage> {
  return withWorker(db, token, options, async (tx, worker) => {
    const ctx = await context(tx, worker.ownerId, options);
    const pending = await tx.select({ intervention: questionInterventions, question: questions, app: applications })
      .from(questionInterventions).innerJoin(questions, and(eq(questions.ownerId, questionInterventions.ownerId),
        eq(questions.id, questionInterventions.questionId)))
      .innerJoin(applications, and(eq(applications.ownerId, questionInterventions.ownerId),
        eq(applications.id, questionInterventions.applicationId)))
      .where(and(eq(questionInterventions.ownerId, worker.ownerId), eq(questionInterventions.workerId, worker.id),
        inArray(questionInterventions.status, ['pending', 'focused'])))
      // Acknowledged focused commands rotate behind untouched commands, including across byte-limited pages.
      .orderBy(questionInterventions.revision, questionInterventions.createdAt, questionInterventions.id);
    const commands: InterventionPage['commands'] = [];
    let bytes = Buffer.byteLength(JSON.stringify({ questionProtocolVersion: 1, commands }));
    for (const { intervention, question, app } of pending) {
      if (!await currentIntervention(tx, intervention, question, app, worker.id, ctx)) continue;
      const command = { ...focusResult(intervention), expectedApplicationRevision: app.revision, fence: app.fence,
        descriptor: question.descriptor, checkpoint: app.checkpoint };
      const added = Buffer.byteLength(JSON.stringify(command)) + Number(commands.length > 0);
      if (bytes + added > INTERVENTION_PAGE_BYTES) {
        if (!commands.length) fail(413, 'INVALID_INPUT', 'Intervention exceeds the worker response byte limit.');
        break;
      }
      commands.push(command); bytes += added;
      if (commands.length === 20) break;
    }
    return { questionProtocolVersion: 1, commands };
  });
}

export async function ackQuestionIntervention(
  db: PrivateDb, token: string, id: string, input: InterventionAck, options: WorkerOptions = {},
): Promise<FocusResult> {
  const command = InterventionAckSchema.parse(input), scope = `question:intervention:${id}`;
  const receipt = { ...command, requestId: command.eventId };
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [intervention] = await tx.select().from(questionInterventions).where(and(
      eq(questionInterventions.ownerId, worker.ownerId), eq(questionInterventions.workerId, worker.id),
      eq(questionInterventions.id, id),
    ));
    if (!intervention) fail(404, 'NOT_FOUND', 'Intervention not found.');
    const replay = await replayCommand<FocusResult>(tx, worker.ownerId, scope, receipt);
    if (replay) return replay; // Historical acknowledgement only; no observation, lease or resume is repeated.
    const { row, app } = await ownedQuestion(tx, worker.ownerId, intervention.questionId);
    const ctx = await context(tx, worker.ownerId, options);
    if (command.expectedRevision !== intervention.revision || command.expectedApplicationRevision !== app.revision ||
        command.fence !== app.fence || !await currentIntervention(tx, intervention, row, app, worker.id, ctx)) fail();
    if (command.result === 'observed') {
      const observation = command.observation!;
      if (observation.kind !== (row.descriptor.kind === 'needs_login' ? 'login_complete' : 'verification_complete') ||
          observation.ats !== app.ats || observation.tenant !== app.tenant || observation.requisition !== app.requisition ||
          observation.observedAt < intervention.createdAt || observation.observedAt > now) fail();
      one(await tx.update(questions).set({ resolvedAt: now, revision: row.revision + 1 })
        .where(and(qScope(worker.ownerId, row.id), eq(questions.revision, row.revision), isNull(questions.resolvedAt))).returning());
      await reschedule(tx, app, ctx);
      const acknowledgement = { kind: 'intervention_observed', questionId: row.id, interventionId: id, observation };
      one(await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId: app.id, eventId: command.eventId,
        requestHash: hashValue([scope, receipt]), acknowledgement, createdAt: now }).returning({ eventId: applicationEvents.eventId }));
    }
    const updated = one(await tx.update(questionInterventions).set({
      status: command.result, reason: command.reason, revision: intervention.revision + 1,
    }).where(and(eq(questionInterventions.ownerId, worker.ownerId), eq(questionInterventions.workerId, worker.id),
      eq(questionInterventions.id, id), eq(questionInterventions.revision, intervention.revision))).returning());
    const result = focusResult(updated);
    await saveCommand(tx, worker.ownerId, scope, receipt, result, now);
    return result;
  });
}
