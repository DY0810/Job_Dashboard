import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from '../private-db/index.ts';
import {
  account, applications, applicationEvents, documents, legacyImportPreviews, manualApplicationMarks,
  policyHeads, policyVersions, profileHeads, profileVersions, user,
  questions, questionAnswers, questionReviews, questionInterventions, inboxReads,
} from '../private-db/schema.ts';
import { createEmptyProfile, type Profile } from './profile.ts';
import { createEmptyPolicy, PolicySchema, type Policy } from './policy.ts';
import { hashValue, saveProfile } from './stores.ts';
import { createPairing, pairWorker, revokeWorker } from './pairing.ts';
import { createRun, enqueueApplication, commandRun } from './runs.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent } from './events.ts';
import { type WorkerOptions } from './worker-store.ts';
import { workerTransport } from '../../worker/transport.ts';
import { screeningQuestions } from '../../worker/screening.ts';
import {
  AnswerCommandSchema, QuestionDescriptorSchema, QuestionDetailSchema, validQuestionAnswer,
  type AnswerCommand, type AnswerValue, type QuestionDescriptor, type QuestionField, type QuestionBatch,
  type InterventionAck,
} from './question-protocol.ts';
import {
  answerQuestion, getInbox, getInboxStatus, getQuestion, markInboxRead, registerQuestionBatch,
  requestQuestionFocus, reviewQuestion,
  pollQuestionInterventions, ackQuestionIntervention,
} from './questions.ts';

vi.mock('server-only', () => ({}));
const nativeFetch = globalThis.fetch;
let db: PrivateDb, other: PrivateDb, dir: string, now: number, options: WorkerOptions, profile: Profile;
const request = () => ({ requestId: randomUUID() });
const secret = () => randomBytes(32).toString('base64url');
const field: QuestionField = { type: 'boolean', allowBlank: false, declineValue: null, units: null, precision: null };
const descriptor = (overrides: Partial<QuestionDescriptor> = {}): QuestionDescriptor => ({
  key: 'availability', kind: 'needs_answer', originalWording: 'Can you work the stated hours?',
  reason: 'User confirmation required.', required: true, meaning: { id: 'stated-hours', reviewId: null },
  schemaVersion: 1, scope: { kind: 'applicant', country: null, employer: null, applicationId: null,
    includesSubsidiaries: false, timeframe: 'current', validFrom: null, validUntil: null,
    ats: 'fixture', tenant: 'employer', version: 1 },
  provenance: { source: 'user', sourceId: null, sourceVersion: null, excerpt: null },
  field, factIds: [], sensitive: false, ...overrides,
});
const appRow = async (id: string) => (await db.select().from(applications).where(eq(applications.id, id)))[0];
const qRow = async (id: string) => (await db.select().from(questions).where(eq(questions.id, id)))[0];
async function prepared(ownerId = 'alice', tenant = 'employer') {
  const grant = await createPairing(db, ownerId, { ...request(), expectedRevision: 0, label: 'Synthetic' }, options);
  const token = secret(), worker = await pairWorker(db, { ...request(), protocolVersion: 1, workerId: randomUUID(),
    grant: grant.grant, workerToken: token, workerVersion: '0.1.0', capabilities: ['control-v1'] }, options);
  const run = await createRun(db, ownerId, { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
  const app = await enqueueApplication(db, ownerId, run.id, { ats: 'fixture', tenant, requisition: randomUUID() }, options);
  return { ownerId, token, worker, run, app };
}
type Fixture = Awaited<ReturnType<typeof prepared>>;
async function batch(f: Fixture, values: QuestionDescriptor[] = [descriptor()]) {
  const lease = (await pollWorker(db, f.token, { protocolVersion: 1 }, options)).lease!;
  expect(lease?.applicationId).toBe(f.app.id);
  const input: QuestionBatch = {
    questionProtocolVersion: 1, eventId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
    expectedProfileRevision: f.ownerId === 'alice' ? (await db.select().from(profileHeads))[0].revision : 0,
    checkpoint: { stage: lease.state as 'screening', sequence: (lease.checkpoint?.sequence ?? 0) + 1 },
    company: 'Synthetic Employer', role: 'Synthetic Engineer',
    questions: values.map(q => ({ ...q, scope: { ...q.scope, ats: lease.ats, tenant: lease.tenant } })),
  };
  const result = await registerQuestionBatch(db, f.token, f.app.id, input, options);
  return { result, input, lease, id: result.questionIds[0] };
}
async function answerInput(id: string, answer: AnswerValue = { type: 'boolean', value: true },
  reuse: AnswerCommand['reuse'] = 'application'): Promise<AnswerCommand> {
  const q = await getQuestion(db, 'alice', id, options);
  return { ...request(), expectedRevision: q.revision, expectedProfileRevision: q.expectedProfileRevision,
    expectedPolicyRevision: q.expectedPolicyRevision, expectedScopeHash: q.expectedScopeHash, factVersions: q.factVersions,
    reuse, answer };
}
async function review(id: string) {
  return reviewQuestion(db, 'alice', id, await reviewInput(id), options);
}
async function reviewInput(id: string) {
  const q = await getQuestion(db, 'alice', id, options);
  return { ...request(), expectedRevision: q.revision, meaningId: q.descriptor.meaning.id,
    expectedProfileRevision: q.expectedProfileRevision, expectedPolicyRevision: q.expectedPolicyRevision,
    expectedScopeHash: q.expectedScopeHash, factVersions: q.factVersions };
}
async function editProfile(referenced: boolean) {
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  const next = structuredClone(profile);
  if (referenced) next.availability.hoursDuringClasses = { ...next.availability.hoursDuringClasses,
    state: 'confirmed', value: 20, confirmedAt: new Date(now).toISOString() };
  else next.identity.preferredName = { ...next.identity.preferredName,
    state: 'confirmed', value: 'Updated synthetic name', confirmedAt: new Date(now).toISOString() };
  return saveProfile(db, 'alice', { ...request(), expectedRevision: 1, profile: next });
}
async function setProfile(next: Profile) {
  const revision = (await db.select().from(profileHeads))[0].revision + 1;
  await db.insert(profileVersions).values({ ownerId: 'alice', revision, profile: next,
    ...request(), requestHash: hashValue(next), createdAt: now });
  await db.update(profileHeads).set({ revision }).where(eq(profileHeads.ownerId, 'alice'));
}
async function setPolicy(changes: Partial<Policy>) {
  const [head] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
  const old = (await db.select().from(policyVersions).where(eq(policyVersions.ownerId, 'alice')))
    .find(row => row.version === head.policyVersion)!;
  const policy = { ...PolicySchema.parse(old.policy), ...changes }, hash = hashValue(policy), version = head.policyVersion + 1;
  await db.insert(policyVersions).values({ ownerId: 'alice', version, hash, policy, createdAt: now });
  await db.update(policyHeads).set({ revision: head.revision + 1, policyVersion: version,
    acceptedPolicyVersion: version, acceptedPolicyHash: hash }).where(eq(policyHeads.ownerId, 'alice'));
}
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase5-dal-'));
  now = Date.UTC(2026, 8, 21, 12);
  options = { now: () => now, isAllowedApplicant: email => ['alice@example.test', 'bob@example.test'].includes(email) };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden'); }));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` }); await migratePrivateDb(db);
  other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
    await db.insert(account).values({ id: `${id}-credential`, userId: id, accountId: id, providerId: 'credential', password: secret() });
    const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs', 'fill_forms'], documentKinds: ['resume', 'transcript'] };
    const hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: id, version: 1, hash, policy, createdAt: now });
    await db.insert(policyHeads).values({ ownerId: id, revision: 1, policyVersion: 1, enabled: true,
      acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  }
  profile = createEmptyProfile();
  await db.insert(profileVersions).values({ ownerId: 'alice', revision: 1, profile,
    ...request(), requestHash: hashValue(profile), createdAt: now });
  await db.insert(profileHeads).values({ ownerId: 'alice', revision: 1 });
});
afterEach(() => {
  other?.$client.close(); db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('question DAL atomic answers and scoped reuse', () => {
  it('stores a missing screening fact for its applicant and resumes only its application once', async () => {
    const a = await prepared(), b = await prepared();
    const context = { applicationId: a.app.id, profileRevision: 1, company: 'Synthetic Employer', role: 'Intern',
      identity: { ats: 'fixture', tenant: 'employer', requisition: a.app.requisition },
      requirements: { sourceUrl: 'https://example.test/role', excerpts: ['Graduating December 2028'] } };
    const generated = screeningQuestions(context as never, ['graduation_unknown']);
    const first = await batch(a, generated.questions);
    expect((await getInboxStatus(db, 'alice', options)).unresolved).toBe(1);
    expect((await getInbox(db, 'alice', {}, options)).items[0].question?.id).toBe(first.id);
    await expect(getQuestion(db, 'bob', first.id, options)).rejects.toMatchObject({ status: 404 });
    const answer = await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'text', value: '2028-12' }), options);
    expect(answer.resumedApplicationIds).toEqual([a.app.id]);
    expect((await appRow(b.app.id)).state).toBe('queued');
    expect((await db.select().from(questionAnswers)).length).toBe(1);
  });
  it('resolves exact reviewed waiters, waits for every blocker, reuses future batches, and replays after reopening', async () => {
    const a = await prepared(), first = await batch(a);
    const b = await prepared(), second = await batch(b, [descriptor(), descriptor({ key: 'other', meaning: { id: 'other', reviewId: null },
      originalWording: 'Do you have another restriction?' })]);
    const unrelated = await prepared(), third = await batch(unrelated, [descriptor({ originalWording: 'Have you ever worked these hours?' })]);
    const foreign = await prepared('bob'), bob = await batch(foreign);
    expect((await getQuestion(db, 'alice', first.id, options)).allowedReuse).toEqual(['application']);
    const reviewed = await review(first.id);
    expect(reviewed).toMatchObject({ canAnswer: true, waitingCount: 2 });
    expect(reviewed.allowedReuse).toContain('equivalent');
    const input = await answerInput(first.id, { type: 'boolean', value: true }, 'equivalent');
    const result = await answerQuestion(db, 'alice', first.id, input, options);
    expect(result.resolvedQuestionIds.sort()).toEqual([first.id, second.id].sort());
    expect(result.resumedApplicationIds).toEqual([a.app.id]);
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null, checkpoint: { stage: 'screening', sequence: 2 } });
    expect(await appRow(b.app.id)).toMatchObject({ state: 'needs_answer' });
    expect((await qRow(third.id)).resolvedAt).toBeNull();
    expect((await qRow(bob.id)).resolvedAt).toBeNull();
    expect((await getQuestion(db, 'alice', first.id, options)).canAnswer).toBe(true);
    const remaining = second.result.questionIds[1];
    const last = await answerQuestion(db, 'alice', remaining, await answerInput(remaining), options);
    expect(last.resumedApplicationIds).toEqual([b.app.id]);
    const count = (await db.select().from(questionAnswers)).length;
    db.$client.close(); db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    expect(await answerQuestion(db, 'alice', first.id, input, options)).toEqual({ ...result, replayed: true });
    expect(await db.select().from(questionAnswers)).toHaveLength(count);
    await expect(answerQuestion(db, 'alice', first.id, { ...input, answer: { type: 'boolean', value: false } }, options))
      .rejects.toMatchObject({ status: 409 });
    const future = await prepared('alice', 'another-employer'), matching = await batch(future);
    expect(await qRow(matching.id)).toMatchObject({ answerId: result.answerId, resolvedAt: now });
    expect(await appRow(future.app.id)).toMatchObject({ state: 'screening', leaseUntil: null });
    expect(await db.select().from(questionReviews)).toHaveLength(1);
  });

  it.each(['application', 'employer'] as const)('never broadens explicit %s reuse', async reuse => {
    const a = await prepared(), first = await batch(a);
    const b = await prepared(), second = await batch(b);
    const c = await prepared('alice', 'different'), third = await batch(c);
    await review(first.id);
    await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'boolean', value: false }, reuse), options);
    expect((await qRow(second.id)).resolvedAt !== null).toBe(reuse === 'employer');
    expect((await qRow(third.id)).resolvedAt).toBeNull();
    const future = await prepared(), fourth = await batch(future);
    expect((await qRow(fourth.id)).resolvedAt !== null).toBe(reuse === 'employer');
  });

  it.each(['submitting', 'submission_unknown', 'submitted', 'failed', 'skipped', 'cancelled'] as const)(
    'an explicit newer answer fences unsent work while preserving %s history', async state => {
      const a = await prepared(), first = await batch(a), b = await prepared(), second = await batch(b);
      await review(first.id);
      const original = await answerQuestion(db, 'alice', first.id,
        await answerInput(first.id, { type: 'boolean', value: true }, 'equivalent'), options);
      const lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
      await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 8 } }).where(eq(applications.id, a.app.id));
      await db.update(applications).set({ state }).where(eq(applications.id, b.app.id));
      const beforeApp = await appRow(b.app.id), beforeQuestion = await qRow(second.id);
      expect((await getQuestion(db, 'alice', second.id, options)).canAnswer).toBe(false);
      await expect(answerQuestion(db, 'alice', second.id, await answerInput(second.id), options)).rejects.toMatchObject({ status: 409 });
      const updated = await answerQuestion(db, 'alice', first.id,
        await answerInput(first.id, { type: 'boolean', value: false }, 'equivalent'), options);
      expect(updated.answerId).not.toBe(original.answerId);
      expect(updated.resolvedQuestionIds).toEqual([first.id]);
      expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null, checkpoint: { stage: 'screening', sequence: 9 } });
      expect((await appRow(a.app.id)).fence).toBeGreaterThan(lease.fence);
      await expect(heartbeatWorker(db, a.token, { protocolVersion: 1, lease: {
        applicationId: a.app.id, expectedRevision: lease.revision, fence: lease.fence,
      } }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
      expect(await appRow(b.app.id)).toEqual(beforeApp); expect(await qRow(second.id)).toEqual(beforeQuestion);
      expect((await db.select().from(questionAnswers).where(eq(questionAnswers.id, original.answerId)))[0].value)
        .toEqual({ type: 'boolean', value: true });
      const future = await prepared('alice', 'future'), later = await batch(future);
      expect((await qRow(later.id)).answerId).toBe(updated.answerId);
      await expect(db.update(questionAnswers).set({ value: { type: 'boolean', value: false } })).rejects.toThrow();
      await expect(db.delete(questionAnswers)).rejects.toThrow();
    });

  it.each(['policy', 'profile', 'fact', 'scope', 'revision', 'fact-list', 'owner', 'stop', 'pause', 'revoke', 'credential', 'manual'] as const)(
    'rejects stale or ineligible %s without writing an answer or scheduling work', async cause => {
      const fact = profile.availability.hoursDuringClasses;
      const a = await prepared(), q = await batch(a, [descriptor({ factIds: [fact.id] })]);
      const input = await answerInput(q.id);
      if (cause === 'policy') await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
      if (cause === 'profile' || cause === 'fact') {
        const next = structuredClone(profile); if (cause === 'fact') next.availability.hoursDuringClasses.version++;
        await setProfile(next);
      }
      if (cause === 'scope') input.expectedScopeHash = '0'.repeat(64);
      if (cause === 'revision') input.expectedRevision++;
      if (cause === 'fact-list') input.factVersions = [];
      if (cause === 'stop' || cause === 'pause') await commandRun(db, 'alice', a.run.id,
        { ...request(), expectedRevision: 1, action: cause }, options);
      if (cause === 'revoke') await revokeWorker(db, 'alice', a.worker.workerId, { ...request(), expectedRevision: 1 }, options);
      if (cause === 'credential') await db.update(account).set({ password: secret() }).where(eq(account.userId, 'alice'));
      if (cause === 'manual') {
        const previewId = randomUUID(), evidence = { postingId: 1, company: 'Synthetic', title: 'Engineer', url: null,
          identity: { ats: 'fixture', tenant: a.app.tenant, requisition: a.app.requisition }, resolution: 'resolved' as const, reason: null };
        await db.insert(legacyImportPreviews).values({ id: previewId, ownerId: 'alice', ...request(), requestHash: '0'.repeat(64),
          preview: { ownerId: 'alice', previewToken: previewId, previewHash: '0'.repeat(64), expiresAt: now + 1000, rows: [evidence] },
          createdAt: now, expiresAt: now + 1000 });
        await db.insert(manualApplicationMarks).values({ id: randomUUID(), ownerId: 'alice', postingId: 1, previewId, evidence,
          ats: 'fixture', tenant: a.app.tenant, requisition: a.app.requisition, createdAt: now });
      }
      const before = await appRow(a.app.id);
      await expect(answerQuestion(db, cause === 'owner' ? 'bob' : 'alice', q.id, input, options)).rejects.toBeDefined();
      expect(await db.select().from(questionAnswers)).toEqual([]);
      expect(await appRow(a.app.id)).toEqual(before);
      if (!['scope', 'revision', 'fact-list', 'owner', 'profile', 'fact'].includes(cause))
        expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
    });

  it.each(['wording', 'options', 'precision', 'timeframe', 'scope-version', 'schema-version', 'facts', 'sensitive'] as const)(
    'does not reuse after changed %s', async change => {
      const numeric: QuestionField = { type: 'number', allowBlank: false, declineValue: null, min: 0, max: 100,
        units: 'hours', precision: 1, integer: false };
      const original = descriptor({ field: numeric });
      const a = await prepared(), q = await batch(a, [original]); await review(q.id);
      await answerQuestion(db, 'alice', q.id,
        await answerInput(q.id, { type: 'number', value: 20, units: 'hours', precision: 1 }, 'equivalent'), options);
      const changed = structuredClone(original);
      if (change === 'wording') changed.originalWording += ' ever?';
      if (change === 'precision') changed.field = { ...numeric, precision: 2 };
      if (change === 'options') changed.field = { type: 'select', allowBlank: false, declineValue: null, units: null, precision: null,
        options: [{ value: '20', label: 'Twenty or more' }], minSelections: 1, maxSelections: 1 };
      if (change === 'timeframe') changed.scope.timeframe = 'ever';
      if (change === 'scope-version') changed.scope.version++;
      if (change === 'schema-version') changed.schemaVersion++;
      if (change === 'facts') changed.factIds = [profile.availability.hoursDuringClasses.id];
      if (change === 'sensitive') changed.sensitive = true;
      const b = await prepared(), later = await batch(b, [changed]);
      expect((await qRow(later.id)).resolvedAt).toBeNull();
      expect((await getQuestion(db, 'alice', later.id, options)).allowedReuse).toEqual(['application']);
    });

  it('serializes competing answers, rolls back failed resume and retains one row per field', async () => {
    const a = await prepared(), q = await batch(a), input = await answerInput(q.id);
    await db.run(sql`create trigger fixture_fail_resume before update on private_application begin select raise(ignore); end`);
    await expect(answerQuestion(db, 'alice', q.id, input, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(questionAnswers)).toHaveLength(0); expect((await qRow(q.id)).resolvedAt).toBeNull();
    await db.run(sql`drop trigger fixture_fail_resume`);
    const responses = await Promise.all([answerQuestion(db, 'alice', q.id, input, options), answerQuestion(other, 'alice', q.id, input, options)]);
    expect(responses[0].answerId).toBe(responses[1].answerId);
    expect(await db.select().from(questionAnswers)).toHaveLength(1);
    expect(await registerQuestionBatch(db, a.token, a.app.id, q.input, options)).toEqual({ ...q.result, replayed: true });
    await expect(registerQuestionBatch(db, a.token, a.app.id, { ...q.input, role: 'Different' }, options)).rejects.toMatchObject({ status: 409 });
    const reobserved = await batch(a, [descriptor({ field: { type: 'select', allowBlank: false, declineValue: null, units: null,
      precision: null, options: [{ value: 'yes', label: 'Yes' }], minSelections: 1, maxSelections: 1 } })]);
    expect(reobserved.id).toBe(q.id);
    expect(await db.select().from(questions)).toHaveLength(1);
    expect((await qRow(q.id)).resolvedAt).toBeNull();
    await expect(answerQuestion(db, 'alice', q.id, { ...input, ...request() }, options)).rejects.toMatchObject({ status: 409 });
  });

  it('requires owner review, refuses forged review IDs and retains application and employer scope limits', async () => {
    const a = await prepared(), original = descriptor();
    const first = await batch(a, [original]);
    await expect(answerQuestion(db, 'alice', first.id,
      await answerInput(first.id, { type: 'boolean', value: false }, 'equivalent'), options)).rejects.toMatchObject({ status: 409 });
    await expect(reviewQuestion(db, 'bob', first.id, await reviewInput(first.id), options))
      .rejects.toMatchObject({ status: 404 });
    await expect(reviewQuestion(db, 'alice', first.id, { ...await reviewInput(first.id), meaningId: 'similar-but-not-exact' }, options))
      .rejects.toMatchObject({ status: 409 });
    const q = await review(first.id);
    expect(q.descriptor.meaning.reviewId).not.toBeNull();
    const b = await prepared();
    const lease = (await pollWorker(db, b.token, { protocolVersion: 1 }, options)).lease!;
    await expect(registerQuestionBatch(db, b.token, b.app.id, { ...first.input, eventId: randomUUID(),
      expectedRevision: lease.revision, fence: lease.fence,
      questions: [descriptor({ meaning: { id: 'changed', reviewId: q.descriptor.meaning.reviewId } })],
    }, options)).rejects.toMatchObject({ status: 409 });
    const c = await prepared('alice', 'scoped');
    const appOnly = await batch(c, [descriptor({ scope: { ...original.scope, kind: 'application', applicationId: c.app.id } })]);
    expect((await review(appOnly.id)).allowedReuse).toEqual(['application']);
    await answerQuestion(db, 'alice', first.id, await answerInput(first.id, { type: 'boolean', value: true }, 'equivalent'), options);
    const d = await prepared('alice', 'scoped-employer');
    const employer = await batch(d, [descriptor({ scope: { ...original.scope, kind: 'employer', employer: 'Different Company' } })]);
    expect((await qRow(employer.id)).resolvedAt).toBeNull();
  });

  it.each(['profile', 'policy', 'expired'] as const)('future batches do not reuse answers after %s changed', async change => {
    const q = descriptor();
    if (change === 'expired') q.scope.validUntil = { value: '2026-09-21', precision: 'day' };
    const a = await prepared(), first = await batch(a, [q]); await review(first.id);
    await answerQuestion(db, 'alice', first.id,
      await answerInput(first.id, { type: 'boolean', value: true }, 'equivalent'), options);
    if (change === 'profile') {
      const next = structuredClone(profile); next.availability.hoursDuringClasses.version++;
      await setProfile(next);
    }
    if (change === 'policy') await setPolicy({ actions: ['read_jobs', 'fill_forms'] });
    if (change === 'expired') now += 86_400_000;
    const b = await prepared(), later = await batch(b, [q]);
    expect((await qRow(later.id)).resolvedAt).toBeNull();
    if (change === 'expired') expect((await getQuestion(db, 'alice', later.id, options)).canAnswer).toBe(false);
  });

  it.each(['lease', 'profile', 'scope', 'fact', 'checkpoint', 'owner'] as const)(
    'rejects invalid %s registration with no question or notification', async change => {
      const a = await prepared(), lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
      const input: QuestionBatch = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: lease.revision,
        fence: lease.fence, expectedProfileRevision: 1, checkpoint: { stage: 'screening', sequence: 1 },
        company: 'Synthetic', role: 'Engineer', questions: [descriptor()] };
      if (change === 'lease') input.fence++;
      if (change === 'profile') input.expectedProfileRevision++;
      if (change === 'scope') input.questions[0].scope.tenant = 'unrelated';
      if (change === 'fact') input.questions[0].factIds = [randomUUID()];
      if (change === 'checkpoint') input.checkpoint.sequence++;
      const b = change === 'owner' ? await prepared('bob') : null;
      await expect(registerQuestionBatch(db, b?.token ?? a.token, a.app.id, input, options)).rejects.toBeDefined();
      expect(await db.select().from(questions)).toHaveLength(0);
      expect(await db.select().from(applicationEvents)).toHaveLength(0);
    });

  it.each([false, true])('cannot clear an independent worker blocker by updating an old answer (pause/resume: %s)', async pause => {
    const a = await prepared(), q = await batch(a);
    await answerQuestion(db, 'alice', q.id, await answerInput(q.id), options);
    const lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
    await recordWorkerEvent(db, a.token, a.app.id, { protocolVersion: 1, eventId: randomUUID(), expectedRevision: lease.revision,
      fence: lease.fence, state: 'needs_verification', reasonCode: 'separate_verification',
      checkpoint: { stage: 'screening', sequence: lease.checkpoint!.sequence + 1 } }, options);
    if (pause) {
      await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 1, action: 'pause' }, options);
      await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 2, action: 'resume' }, options);
    }
    const before = await appRow(a.app.id);
    expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
    await expect(answerQuestion(db, 'alice', q.id, await answerInput(q.id, { type: 'boolean', value: false }), options))
      .rejects.toMatchObject({ status: 409 });
    expect(await appRow(a.app.id)).toEqual(before);
    expect(await db.select().from(questionAnswers)).toHaveLength(1);
  });

  it('still answers an original question blocker after an authorized run pause and resume', async () => {
    const a = await prepared(), q = await batch(a);
    await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 1, action: 'pause' }, options);
    await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 2, action: 'resume' }, options);
    expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(true);
    expect((await answerQuestion(db, 'alice', q.id, await answerInput(q.id), options)).resumedApplicationIds).toEqual([a.app.id]);
  });

  it.each([
    { referenced: true, reviewed: true }, { referenced: false, reviewed: true },
    { referenced: true, reviewed: false }, { referenced: false, reviewed: false },
  ])('recovers a waiting question after a real profile save ($referenced, review: $reviewed)', async ({ referenced, reviewed }) => {
    const a = await prepared(), q = await batch(a, [descriptor({ factIds: [profile.availability.hoursDuringClasses.id] })]);
    const staleAnswer = await answerInput(q.id), staleReview = await reviewInput(q.id);
    await editProfile(referenced);
    await expect(answerQuestion(db, 'alice', q.id, staleAnswer, options)).rejects.toMatchObject({ status: 409 });
    await expect(reviewQuestion(db, 'alice', q.id, staleReview, options)).rejects.toMatchObject({ status: 409 });
    const current = await getQuestion(db, 'alice', q.id, options);
    expect(current).toMatchObject({ canAnswer: true, expectedProfileRevision: 2,
      factVersions: [{ id: profile.availability.hoursDuringClasses.id, version: referenced ? 2 : 1 }] });
    expect(await appRow(a.app.id)).toMatchObject({ state: 'needs_answer', leaseUntil: null });
    if (reviewed) {
      await review(q.id);
      expect((await qRow(q.id)).resolvedAt).toBeNull();
      expect(await db.select().from(questionAnswers)).toHaveLength(0);
    }
    const result = await answerQuestion(db, 'alice', q.id, await answerInput(q.id), options);
    expect(result.resumedApplicationIds).toEqual([a.app.id]);
    expect(await qRow(q.id)).toMatchObject({ profileRevision: 2, factVersions: current.factVersions });
  });

  it('current-profile answer updates fence active work without reusing stale facts or rewriting submitted answers', async () => {
    const descriptorWithFact = descriptor({ factIds: [profile.availability.hoursDuringClasses.id] });
    const a = await prepared(), first = await batch(a, [descriptorWithFact]);
    const b = await prepared(), second = await batch(b, [descriptorWithFact]);
    await review(first.id);
    const original = await answerQuestion(db, 'alice', first.id,
      await answerInput(first.id, { type: 'boolean', value: true }, 'equivalent'), options);
    await db.update(applications).set({ state: 'submitted' }).where(eq(applications.id, b.app.id));
    const historical = await qRow(second.id), oldAnswer = (await db.select().from(questionAnswers))[0];
    const lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
    await editProfile(true);
    const c = await prepared('alice', 'new'), third = await batch(c, [descriptorWithFact]);
    expect((await qRow(third.id)).resolvedAt).toBeNull();
    const revised = await answerQuestion(db, 'alice', first.id,
      await answerInput(first.id, { type: 'boolean', value: false }, 'equivalent'), options);
    expect(revised.answerId).not.toBe(original.answerId);
    expect(revised.resolvedQuestionIds.sort()).toEqual([first.id, third.id].sort());
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null });
    expect((await appRow(a.app.id)).fence).toBeGreaterThan(lease.fence);
    expect(await qRow(second.id)).toEqual(historical);
    expect((await db.select().from(questionAnswers).where(eq(questionAnswers.id, original.answerId)))[0]).toEqual(oldAnswer);
  });
});

describe('typed validation, optional questions and inbox receipts', () => {
  it.each(['needs_login', 'needs_verification', 'provider_unavailable', 'failed'] as const)(
    'keeps unresolved %s interventions visible without allowing a typed answer', async kind => {
      const a = await prepared(), q = await batch(a, [descriptor({ kind,
        field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } })]);
      expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unread: 1, unresolved: 1, waitingApplications: 1 });
      expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
      expect((await getInbox(db, 'alice', {}, options)).items[0].kind).toBe(kind);
    });

  it('keeps reads private, paginates stably and never resolves through read receipts', async () => {
    const a = await prepared(), q = await batch(a, [descriptor(), descriptor({ key: 'second' })]);
    const initial = await getInboxStatus(db, 'alice', options);
    expect(initial).toMatchObject({ unread: 2, unresolved: 2, waitingApplications: 1 });
    const page = await getInbox(db, 'alice', { limit: 1 }, options);
    expect(page.items).toHaveLength(1); expect(page.nextCursor).not.toBeNull();
    const next = await getInbox(db, 'alice', { limit: 1, cursor: page.nextCursor! }, options);
    expect(next.items[0].eventId).not.toBe(page.items[0].eventId);
    expect(await getInboxStatus(db, 'alice', options)).toEqual(initial);
    await expect(markInboxRead(db, 'bob', { eventIds: [page.items[0].eventId] })).rejects.toMatchObject({ status: 404 });
    const command = { eventIds: [page.items[0].eventId] };
    expect(await markInboxRead(db, 'alice', command)).toEqual({ ownerId: 'alice', ...command });
    expect(await markInboxRead(other, 'alice', command)).toEqual({ ownerId: 'alice', ...command });
    expect(await db.select().from(inboxReads)).toHaveLength(1);
    expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unread: 1, unresolved: 2, waitingApplications: 1 });
    expect((await getQuestion(db, 'alice', q.id, options)).resolved).toBe(false);
    await expect(getQuestion(db, 'bob', q.id, options)).rejects.toMatchObject({ status: 404 });
    expect((await getInbox(db, 'bob', {}, options)).items).toEqual([]);
  });

  it('optional policy-permitted blanks do not block or fabricate a user answer', async () => {
    const a = await prepared(), q = await batch(a, [descriptor({ required: false, field: { ...field, allowBlank: true } })]);
    expect(await qRow(q.id)).toMatchObject({ resolvedAt: now, answerId: null });
    expect(await appRow(a.app.id)).toMatchObject({ state: 'screening', leaseUntil: null });
    expect(await getInboxStatus(db, 'alice', options)).toMatchObject({ unread: 0, unresolved: 0, waitingApplications: 0 });
    expect(await db.select().from(questionAnswers)).toHaveLength(0);
  });

  it('requires fill permission and honors sensitive ask-each policy without wider reuse', async () => {
    await setPolicy({ actions: ['read_jobs'] });
    const a = await prepared(), q = await batch(a);
    expect((await getQuestion(db, 'alice', q.id, options)).canAnswer).toBe(false);
    await expect(answerQuestion(db, 'alice', q.id, await answerInput(q.id), options)).rejects.toMatchObject({ status: 409 });
    await setPolicy({ actions: ['read_jobs', 'fill_forms'], disclosure: 'ask_each_sensitive' });
    const b = await prepared(), sensitive = await batch(b, [descriptor({ sensitive: true })]);
    expect((await review(sensitive.id)).allowedReuse).toEqual(['application']);
    await expect(answerQuestion(db, 'alice', sensitive.id,
      await answerInput(sensitive.id, { type: 'boolean', value: true }, 'equivalent'), options)).rejects.toMatchObject({ status: 409 });
  });

  it('requires owned, available, policy-permitted document version and exact hash', async () => {
    const id = randomUUID(), bad = randomUUID();
    for (const [documentId, ownerId, state] of [[id, 'alice', 'available'], [bad, 'bob', 'available']] as const) {
      await db.insert(documents).values({ id: documentId, masterId: documentId, ownerId, kind: 'transcript', name: 'Synthetic.pdf',
        version: 1, objectKey: documentId, storage: 'local', mime: 'application/pdf', size: 100, sha256: 'a'.repeat(64),
        state, safetyCheck: 'passed', createdAt: now });
    }
    const a = await prepared(), q = await batch(a, [descriptor({ kind: 'needs_document', field: {
      type: 'document', allowBlank: false, declineValue: null, units: null, precision: null,
      documentKinds: ['transcript'], mimeTypes: ['application/pdf'], maxBytes: 1000,
    } })]);
    for (const value of [{ documentId: bad, version: 1, sha256: 'a'.repeat(64) },
      { documentId: id, version: 2, sha256: 'a'.repeat(64) }, { documentId: id, version: 1, sha256: 'b'.repeat(64) }]) {
      await expect(answerQuestion(db, 'alice', q.id, await answerInput(q.id, { type: 'document', ...value }), options)).rejects.toMatchObject({ status: 409 });
    }
    const input = await answerInput(q.id, { type: 'document', documentId: id, version: 1, sha256: 'a'.repeat(64) });
    expect((await answerQuestion(db, 'alice', q.id, input, options)).resumedApplicationIds).toEqual([a.app.id]);
  });

  it('validates actual date, option, units and precision without coercion', () => {
    const date = descriptor({ field: { type: 'date', allowBlank: false, declineValue: null, units: null,
      precision: 'day', min: '2026-01-01', max: '2026-12-31' } });
    for (const value of ['2026-02-30', '2025-12-31', '2027-01-01', '2026-06'])
      expect(validQuestionAnswer(date, { type: 'date', value, precision: 'day' }, false)).toBe(false);
    expect(validQuestionAnswer(date, { type: 'date', value: '2026-09-21', precision: 'day' }, false)).toBe(true);
    const number = descriptor({ field: { type: 'number', allowBlank: false, declineValue: null, min: 0, max: 40,
      units: 'hours', precision: 1, integer: false } });
    for (const answer of [{ type: 'number', value: 20.11, units: 'hours', precision: 1 },
      { type: 'number', value: 20, units: 'days', precision: 1 }, { type: 'text', value: '20' }] as AnswerValue[])
      expect(validQuestionAnswer(number, answer, false)).toBe(false);
    expect(QuestionDescriptorSchema.safeParse({ ...date, required: true, field: { ...date.field, allowBlank: true } }).success).toBe(false);
    expect(AnswerCommandSchema.safeParse({ ownerId: 'bob' }).success).toBe(false);
  });

  it('does not bypass blank, decline or safe numeric precision through another answer variant', () => {
    const text = descriptor({ required: false, field: { type: 'text', allowBlank: false, declineValue: null,
      minLength: 0, maxLength: 20, format: 'plain', units: null, precision: null } });
    expect(validQuestionAnswer(text, { type: 'text', value: '' }, true)).toBe(false);
    const choice = descriptor({ required: false, field: { type: 'multiselect', allowBlank: false, declineValue: 'decline',
      options: [{ value: 'yes', label: 'Yes' }, { value: 'decline', label: 'Decline' }],
      minSelections: 0, maxSelections: 2, units: null, precision: null } });
    expect(validQuestionAnswer(choice, { type: 'choices', value: [] }, true)).toBe(false);
    expect(validQuestionAnswer(choice, { type: 'choices', value: ['decline'] }, false)).toBe(false);
    const numeric = descriptor({ field: { type: 'number', allowBlank: false, declineValue: null,
      min: 0, max: 1e30, units: 'dollars', precision: 2, integer: false } });
    expect(validQuestionAnswer(numeric, { type: 'number', value: 1e25, units: 'dollars', precision: 2 }, false)).toBe(false);
  });

  it('focus is an idempotent assigned-worker request, never resolution or a synthetic observation', async () => {
    const a = await prepared(), q = await batch(a, [descriptor({ kind: 'needs_login',
      field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } })]);
    const detail = await getQuestion(db, 'alice', q.id, options);
    expect(QuestionDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail.canAnswer).toBe(false);
    const input = { ...request(), expectedRevision: detail.revision };
    const result = await requestQuestionFocus(db, 'alice', q.id, input, options);
    expect(result).toMatchObject({ questionId: q.id, applicationId: a.app.id, workerId: a.worker.workerId, status: 'pending' });
    expect(await requestQuestionFocus(other, 'alice', q.id, input, options)).toEqual(result);
    expect(await db.select().from(questionInterventions)).toHaveLength(1);
    expect((await qRow(q.id)).resolvedAt).toBeNull();
    expect(await appRow(a.app.id)).toMatchObject({ state: 'needs_login' });
    await expect(requestQuestionFocus(db, 'bob', q.id, input, options)).rejects.toMatchObject({ status: 404 });
  });
});

describe('worker intervention DAL', () => {
  async function pending(kind: 'needs_login' | 'needs_verification' = 'needs_login', blocker = false) {
    const a = await prepared(), q = await batch(a, [descriptor({ kind, key: 'human',
      factIds: [profile.availability.hoursDuringClasses.id],
      field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } }),
    ...(blocker ? [descriptor()] : [])]);
    const focus = await requestQuestionFocus(db, 'alice', q.id, { ...request(), expectedRevision: (await qRow(q.id)).revision }, options);
    const app = await appRow(a.app.id);
    const input: InterventionAck = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: focus.revision,
      expectedApplicationRevision: app.revision, fence: app.fence, result: 'observed', reason: null,
      observation: { kind: kind === 'needs_login' ? 'login_complete' : 'verification_complete',
        ats: app.ats, tenant: app.tenant, requisition: app.requisition, observedAt: now } };
    return { a, q, focus, input };
  }

  it('byte-bounds twenty large commands through real worker transport and fairly advances focused work', async () => {
    const a = await prepared(), ids = new Set<string>(), wording = '\u4e2d'.repeat(4000), reason = '\u6587'.repeat(4000);
    for (let index = 0; index < 20; index++) {
      const app = index === 0 ? a.app : await enqueueApplication(db, 'alice', a.run.id,
        { ats: 'fixture', tenant: `large-${index}`, requisition: randomUUID() }, options);
      const q = await batch({ ...a, app }, [descriptor({ kind: 'needs_login', originalWording: wording, reason,
        field: { type: 'intervention', allowBlank: false, declineValue: null, units: null, precision: null } })]);
      ids.add((await requestQuestionFocus(db, 'alice', q.id,
        { ...request(), expectedRevision: (await qRow(q.id)).revision }, options)).id);
    }
    const responseBytes: number[] = [];
    const server = createServer(async (request, response) => {
      request.resume();
      if (request.url !== '/api/worker/interventions' || request.method !== 'POST' ||
          request.headers.authorization !== `Bearer ${a.token}`) { response.writeHead(403).end(); return; }
      try {
        const body = JSON.stringify(await pollQuestionInterventions(db, a.token, options));
        responseBytes.push(Buffer.byteLength(body));
        response.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }).end(body);
      } catch { response.writeHead(500).end(); }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Missing loopback fixture address.');
    const origin = `http://127.0.0.1:${address.port}`;
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      if (new URL(url).origin !== origin) throw new Error('External network forbidden.');
      return nativeFetch(input, init);
    });
    try {
      const transport = workerTransport({ origin, token: a.token, allowLoopback: true }), processed = new Set<string>();
      for (let index = 0; index < 20; index++) {
        const page = await transport.interventions();
        expect(page.commands.length).toBeGreaterThan(0);
        expect(page.commands.length).toBeLessThan(20);
        expect(page.commands.every(c => c.descriptor.originalWording === wording && c.descriptor.reason === reason)).toBe(true);
        const command = page.commands[0];
        expect(processed.has(command.id)).toBe(false);
        processed.add(command.id);
        await ackQuestionIntervention(db, a.token, command.id, {
          questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: command.revision,
          expectedApplicationRevision: command.expectedApplicationRevision, fence: command.fence,
          result: 'focused', reason: null, observation: null,
        }, options);
      }
      expect(processed).toEqual(ids);
      expect(responseBytes).toHaveLength(20);
      expect(responseBytes.every(bytes => bytes < 128 * 1024)).toBe(true);
      expect((await getInboxStatus(db, 'alice', options)).unresolved).toBe(20);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('rejects a descriptor exceeding the stored byte limit before it can enter a worker page', async () => {
    const a = await prepared(), lease = (await pollWorker(db, a.token, { protocolVersion: 1 }, options)).lease!;
    const oversized = descriptor({ originalWording: '\u4e2d'.repeat(4000), reason: '\u6587'.repeat(4000), field: {
      type: 'select', allowBlank: false, declineValue: null, units: null, precision: null, minSelections: 1, maxSelections: 1,
      options: Array.from({ length: 100 }, (_, i) => ({ value: `${String(i).padStart(3, '0')}${'v'.repeat(297)}`, label: 'l'.repeat(300) })),
    } });
    expect(QuestionDescriptorSchema.safeParse(oversized).success).toBe(true);
    const input: QuestionBatch = { questionProtocolVersion: 1, eventId: randomUUID(), expectedRevision: lease.revision,
      fence: lease.fence, expectedProfileRevision: 1, checkpoint: { stage: 'screening', sequence: 1 },
      company: 'Synthetic', role: 'Engineer', questions: [oversized] };
    expect(Buffer.byteLength(JSON.stringify(input))).toBeLessThan(128 * 1024);
    await expect(registerQuestionBatch(db, a.token, a.app.id, input, options)).rejects.toMatchObject({ status: 413 });
    expect(await db.select().from(questions)).toHaveLength(0);
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
  });

  it('polls only the assigned worker and keeps focused/unavailable acknowledgements separate from resolution', async () => {
    const { a, q, focus, input } = await pending();
    const wrong = await prepared(), bob = await prepared('bob');
    expect((await pollQuestionInterventions(db, wrong.token, options)).commands).toEqual([]);
    expect((await pollQuestionInterventions(db, bob.token, options)).commands).toEqual([]);
    const page = await pollQuestionInterventions(db, a.token, options);
    expect(page).toMatchObject({ questionProtocolVersion: 1, commands: [{ id: focus.id, questionId: q.id,
      workerId: a.worker.workerId, expectedApplicationRevision: input.expectedApplicationRevision, fence: input.fence, status: 'pending' }] });
    const before = await appRow(a.app.id), row = await qRow(q.id);
    const focused = { ...input, result: 'focused' as const, observation: null };
    const result = await ackQuestionIntervention(db, a.token, focus.id, focused, options);
    expect(result).toMatchObject({ status: 'focused', revision: focus.revision + 1 });
    expect(await ackQuestionIntervention(other, a.token, focus.id, focused, options)).toEqual(result);
    expect(await appRow(a.app.id)).toEqual(before); expect(await qRow(q.id)).toEqual(row);
    expect((await pollQuestionInterventions(db, a.token, options)).commands[0].revision).toBe(result.revision);
    const unavailable = await ackQuestionIntervention(db, a.token, focus.id, { ...input, eventId: randomUUID(),
      expectedRevision: result.revision, result: 'unavailable', reason: 'No paired browser window.', observation: null }, options);
    expect(unavailable.status).toBe('unavailable');
    expect((await pollQuestionInterventions(db, a.token, options)).commands).toEqual([]);
    expect(await appRow(a.app.id)).toEqual(before); expect(await qRow(q.id)).toEqual(row);
    await expect(ackQuestionIntervention(db, a.token, focus.id,
      { ...input, eventId: randomUUID(), expectedRevision: unavailable.revision }, options)).rejects.toMatchObject({ status: 409 });
  });

  it.each([
    { kind: 'needs_login' as const, blocker: false }, { kind: 'needs_login' as const, blocker: true },
    { kind: 'needs_verification' as const, blocker: false }, { kind: 'needs_verification' as const, blocker: true },
  ])('observed $kind resolves only its question and respects other blockers ($blocker)', async ({ kind, blocker }) => {
    const { a, q, focus, input } = await pending(kind, blocker);
    const result = await ackQuestionIntervention(db, a.token, focus.id, input, options);
    expect(result.status).toBe('observed');
    expect(await qRow(q.id)).toMatchObject({ resolvedAt: now, answerId: null });
    expect(await appRow(a.app.id)).toMatchObject({ state: blocker ? 'needs_answer' : 'screening', leaseUntil: null,
      checkpoint: { stage: 'screening', sequence: 2 } });
    expect((await pollQuestionInterventions(db, a.token, options)).commands).toEqual([]);
    expect(await db.select().from(questionAnswers)).toHaveLength(0);
    const events = await db.select().from(applicationEvents);
    expect(events.some(e => (e.acknowledgement as { observation?: unknown }).observation &&
      hashValue((e.acknowledgement as { observation: unknown }).observation) === hashValue(input.observation))).toBe(true);
    expect(await ackQuestionIntervention(other, a.token, focus.id, input, options)).toEqual(result);
    expect(await db.select().from(applicationEvents)).toEqual(events);
    if (blocker) {
      const remaining = q.result.questionIds[1];
      expect((await answerQuestion(db, 'alice', remaining, await answerInput(remaining), options)).resumedApplicationIds).toEqual([a.app.id]);
    }
  });

  it.each(['owner', 'worker', 'command-revision', 'question-revision', 'application-revision', 'fence', 'role', 'tenant',
    'ats', 'observation-kind', 'future-observation', 'old-observation', 'profile', 'policy', 'revoke', 'submit', 'answer-update', 'stop'] as const)(
    'rejects %s intervention acknowledgement without resolving or resuming', async fault => {
      const { a, q, focus, input } = await pending('needs_login', true);
      let token = a.token;
      if (fault === 'owner' || fault === 'worker') token = (await prepared(fault === 'owner' ? 'bob' : 'alice')).token;
      if (fault === 'command-revision') input.expectedRevision++;
      if (fault === 'question-revision') await db.update(questions).set({ revision: 2 }).where(eq(questions.id, q.id));
      if (fault === 'application-revision') input.expectedApplicationRevision++;
      if (fault === 'fence') input.fence++;
      if (fault === 'role') input.observation!.requisition = 'other-role';
      if (fault === 'tenant') input.observation!.tenant = 'other-tenant';
      if (fault === 'ats') input.observation!.ats = 'other-ats';
      if (fault === 'observation-kind') input.observation!.kind = 'verification_complete';
      if (fault === 'future-observation') input.observation!.observedAt++;
      if (fault === 'old-observation') input.observation!.observedAt--;
      if (fault === 'profile') await editProfile(true);
      if (fault === 'policy') await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
      if (fault === 'revoke') await revokeWorker(db, 'alice', a.worker.workerId, { ...request(), expectedRevision: 1 }, options);
      if (fault === 'submit') await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, a.app.id));
      if (fault === 'answer-update') {
        const other = q.result.questionIds[1];
        await answerQuestion(db, 'alice', other, await answerInput(other), options);
      }
      if (fault === 'stop') await commandRun(db, 'alice', a.run.id, { ...request(), expectedRevision: 1, action: 'stop' }, options);
      const before = await appRow(a.app.id), question = await qRow(q.id);
      await expect(ackQuestionIntervention(db, token, focus.id, input, options)).rejects.toBeDefined();
      expect(await appRow(a.app.id)).toEqual(before); expect(await qRow(q.id)).toEqual(question);
      expect((await db.select().from(questionInterventions))[0].status).toBe('pending');
      if (['question-revision', 'profile', 'policy', 'submit', 'answer-update', 'stop'].includes(fault))
        expect((await pollQuestionInterventions(db, a.token, options)).commands).toEqual([]);
      if (fault === 'revoke') await expect(pollQuestionInterventions(db, a.token, options)).rejects.toMatchObject({ status: 401 });
    });

  it('rolls back observation and receipt if the application resume fails', async () => {
    const { a, q, focus, input } = await pending();
    const before = await db.select().from(applicationEvents);
    await db.run(sql`create trigger fixture_intervention_fail before update on private_application begin select raise(ignore); end`);
    await expect(ackQuestionIntervention(db, a.token, focus.id, input, options)).rejects.toMatchObject({ status: 409 });
    expect((await qRow(q.id)).resolvedAt).toBeNull();
    expect((await db.select().from(questionInterventions))[0].status).toBe('pending');
    expect(await db.select().from(applicationEvents)).toEqual(before);
    await db.run(sql`drop trigger fixture_intervention_fail`);
    expect((await ackQuestionIntervention(db, a.token, focus.id, input, options)).status).toBe('observed');
  });
});
