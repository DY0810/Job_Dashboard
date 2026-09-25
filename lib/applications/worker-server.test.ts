import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import { account, applications, applicationReceipts, applicationRuns, applicationEvents, applicationSubmissions, policyHeads, policyVersions, user, workerPairings, workers, workerCommands } from '../private-db/schema.ts';
import { createEmptyPolicy } from './policy.ts';
import { hashValue } from './stores.ts';
import { APPLICATION_STATES, SAFE_STAGES, canTransition, type ApplicationState } from './state.ts';
import * as p from './worker-protocol.ts';
import { createPairing, pairWorker, listWorkers, revokeWorker, revokePairing } from './pairing.ts';
import { createRun, enqueueApplication, listRuns, commandRun, commandApplication } from './runs.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent, submitIntent } from './events.ts';
import { beginSubmission, recordReceipt } from './submissions.ts';
import { type WorkerOptions } from './worker-store.ts';

vi.mock('server-only', () => ({}));
let db: PrivateDb, other: PrivateDb, dir: string, now: number, options: WorkerOptions;
const secret = () => randomBytes(32).toString('base64url');
const revision = (expectedRevision: number) => ({ expectedRevision, requestId: randomUUID() });
const ref = (lease: p.Lease) => ({ applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision });
async function paired(ownerId = 'alice') {
  const grant = await createPairing(db, ownerId, { ...revision(0), expectedRevision: 0, label: 'Synthetic worker' }, options);
  const input: p.PairRequest = {
    protocolVersion: 1, workerId: randomUUID(), requestId: randomUUID(), grant: grant.grant,
    workerToken: secret(), workerVersion: '0.1.0', capabilities: ['control-v1'],
  };
  const worker = await pairWorker(db, input, options);
  return { ...worker, input, grant, token: input.workerToken };
}
async function prepared(ownerId = 'alice', tenant = 'fixture', requisition: string = randomUUID()) {
  const worker = await paired(ownerId);
  const run = await createRun(db, ownerId, { expectedRevision: 0, requestId: randomUUID(), workerId: worker.workerId }, options);
  const app = await enqueueApplication(db, ownerId, run.id, { ats: 'fixture', tenant, requisition }, options);
  return { worker, run, app };
}
async function claim(token: string) {
  const response = await pollWorker(db, token, { protocolVersion: 1 }, options);
  p.PollResponseSchema.parse(response);
  expect(response.lease).not.toBeNull();
  return response.lease!;
}
const event = (lease: p.Lease, state: ApplicationState = lease.state, sequence = (lease.checkpoint?.sequence ?? 0) + 1): p.EventRequest => ({
  protocolVersion: 1, eventId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
  state, checkpoint: { stage: lease.state as p.Checkpoint['stage'], sequence }, reasonCode: null,
});

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase3-server-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden.'); }));
  now = 1_800_000_000_000;
  options = { now: () => now, isAllowedApplicant: (email) => ['alice@example.test', 'bob@example.test'].includes(email) };
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
    await db.insert(account).values({ id: `${id}-credential`, userId: id, accountId: id, providerId: 'credential', password: secret() });
    const policy = createEmptyPolicy(), hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: id, version: 1, hash, policy, createdAt: now });
    await db.insert(policyHeads).values({ ownerId: id, revision: 1, policyVersion: 1, enabled: true,
      acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  }
});
afterEach(() => {
  other?.$client.close(); db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('Phase 3 pure protocol and transition guards', () => {
  it('is strict, has no owner authority, and requires evidence for irreversible progression', () => {
    expect(p.PairingCreateSchema.safeParse({ ...revision(0), label: 'Host', ownerId: 'bob' }).success).toBe(false);
    expect(p.PollRequestSchema.safeParse({ protocolVersion: 2 }).success).toBe(false);
    expect(canTransition('queued', 'screening')).toBe(true);
    expect(canTransition('screening', 'tailoring')).toBe(true);
    expect(canTransition('tailoring', 'filling')).toBe(false);
    expect(canTransition('tailoring', 'filling', { artifactVerified: true })).toBe(true);
    expect(canTransition('filling', 'ready')).toBe(false);
    expect(canTransition('ready', 'submitting')).toBe(false);
    expect(canTransition('submitting', 'submission_unknown')).toBe(true);
    for (const state of APPLICATION_STATES) {
      expect(canTransition('submitted', state)).toBe(false);
      expect(canTransition('submission_unknown', state)).toBe(false);
    }
    expect(canTransition('submission_unknown', 'submitted', { receiptVerified: true })).toBe(true);
  });
});
describe('hashed owner-approved pairings', () => {
  it('binds a durable submission intent and immutable exact-role receipt', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
    const intentId = randomUUID();
    const identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
    const started = await beginSubmission(db, worker.token, app.id, {
      protocolVersion: 1, intentId, fence: lease.fence, expectedRevision: lease.revision,
      identity, company: 'Fixture Co', role: 'Software Engineering Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, options);
    expect(started).toMatchObject({ applicationId: app.id, intentId, state: 'submitting', replayed: false });
    const receipt = await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern',
      },
    }, options);
    expect(receipt).toMatchObject({ applicationId: app.id, intentId, state: 'submitted', replayed: false });
    expect(await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern',
      },
    }, options)).toMatchObject({ replayed: true, state: 'submitted' });
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0]).toMatchObject({ state: 'submitted', leaseUntil: null });
  });
  it('fails closed for owner and identity mismatches and rejects receipt replay changes', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
    const identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
    const base = {
      protocolVersion: 1 as const, intentId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
      identity, company: 'Fixture Co', role: 'Software Engineering Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    };
    await expect(beginSubmission(db, worker.token, app.id, { ...base, identity: { ...identity, tenant: 'other' } }, options))
      .rejects.toMatchObject({ status: 409, code: 'IDENTITY_MISMATCH' });
    expect(await db.select().from(applicationSubmissions)).toHaveLength(0);
    const intent = await beginSubmission(db, worker.token, app.id, base, options);
    await expect(recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId: intent.intentId, identity, company: 'Fixture Co', role: 'Other role',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Other role',
      },
    }, options)).rejects.toMatchObject({ status: 409, code: 'RECEIPT_IDENTITY_MISMATCH' });
    const receipt = {
      protocolVersion: 1 as const, intentId: intent.intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern',
      receiptId: 'receipt-123', submittedAt: now, evidence: {
        source: 'confirmation_page' as const, pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern',
      },
    };
    await recordReceipt(db, worker.token, app.id, receipt, options);
    await expect(recordReceipt(db, worker.token, app.id, { ...receipt, receiptId: 'receipt-456' }, options))
      .rejects.toMatchObject({ status: 409 });
    const bob = await paired('bob');
    await expect(recordReceipt(db, bob.token, app.id, receipt, options)).rejects.toMatchObject({ status: 409 });
  });
  it('enforces immutable intent and receipt rows at the database boundary', async () => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
    const identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
    const intentId = randomUUID();
    await beginSubmission(db, worker.token, app.id, {
      protocolVersion: 1, intentId, fence: lease.fence, expectedRevision: lease.revision, identity,
      company: 'Fixture Co', role: 'Software Engineering Intern', manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)],
    }, options);
    await recordReceipt(db, worker.token, app.id, {
      protocolVersion: 1, intentId, identity, company: 'Fixture Co', role: 'Software Engineering Intern', receiptId: 'receipt-123',
      submittedAt: now, evidence: { source: 'confirmation_page', pageUrl: 'https://boards.greenhouse.io/fixture/jobs/123', observedText: 'Fixture Co Software Engineering Intern' },
    }, options);
    await expect(db.update(applicationSubmissions).set({ role: 'Changed' }).where(eq(applicationSubmissions.intentId, intentId))).rejects.toThrow();
    await expect(db.delete(applicationSubmissions).where(eq(applicationSubmissions.intentId, intentId))).rejects.toThrow();
    await expect(db.update(applicationReceipts).set({ role: 'Changed' }).where(eq(applicationReceipts.intentId, intentId))).rejects.toThrow();
    await expect(db.delete(applicationReceipts).where(eq(applicationReceipts.intentId, intentId))).rejects.toThrow();
    const triggers = await db.all(sql`select name from sqlite_master where type = 'trigger' and name in
      ('private_submission_identity_immutable', 'private_submission_no_delete', 'private_receipt_no_update', 'private_receipt_no_delete')`);
    expect(triggers.map((row) => (row as { name: string }).name).sort()).toEqual([
      'private_receipt_no_delete', 'private_receipt_no_update', 'private_submission_identity_immutable', 'private_submission_no_delete',
    ]);
  });
  it.each(['pair', 'list'] as const)('persists stale pending-grant revocation on %s after a credential change', async (operation) => {
    const grant = await createPairing(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, label: 'Pending' }, options);
    const bob = await createPairing(db, 'bob', { requestId: randomUUID(), expectedRevision: 0, label: 'Other owner' }, options);
    await db.update(account).set({ password: secret() }).where(eq(account.userId, 'alice'));
    if (operation === 'pair') {
      await expect(pairWorker(db, { protocolVersion: 1, requestId: randomUUID(), workerId: randomUUID(),
        workerToken: secret(), grant: grant.grant, workerVersion: '0.1', capabilities: ['control-v1'] }, options))
        .rejects.toMatchObject({ status: 401 });
    } else await listWorkers(db, 'alice', options);
    expect((await db.select().from(workerPairings).where(eq(workerPairings.id, grant.pairingId)))[0])
      .toMatchObject({ revokedAt: now, revision: 2, consumedAt: null });
    expect((await db.select().from(workerPairings).where(eq(workerPairings.id, bob.pairingId)))[0].revokedAt).toBeNull();
    expect(await db.select().from(workers)).toHaveLength(0);
  });
  it('reports lost grant creation explicitly without minting a replacement', async () => {
    const command = { requestId: randomUUID(), expectedRevision: 0 as const, label: 'Pending' };
    await createPairing(db, 'alice', command, options);
    await expect(createPairing(other, 'alice', command, options)).rejects.toMatchObject({ code: 'GRANT_UNAVAILABLE' });
    expect(await db.select().from(workerPairings)).toHaveLength(1);
  });
  it('reconciles a lost registration response after expiry, without another worker or secret persistence', async () => {
    const worker = await paired();
    now += p.PAIRING_TTL_MS + 1;
    const again = await pairWorker(other, worker.input, options);
    expect(again.workerId).toBe(worker.workerId);
    const stored = JSON.stringify([await db.select().from(workers), await db.select().from(workerPairings)]);
    expect(stored).not.toContain(worker.token);
    expect(stored).not.toContain(worker.grant.grant);
    expect(await db.select().from(workers)).toHaveLength(1);
    await expect(pairWorker(db, { ...worker.input, requestId: randomUUID() }, options)).rejects.toMatchObject({ status: 409 });
    await expect(pairWorker(db, { ...worker.input, workerToken: secret() }, options)).rejects.toMatchObject({ status: 409 });
  });
  it('atomically consumes once across async clients and rejects expired or revoked grants', async () => {
    const grant = await createPairing(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, label: 'Host' }, options);
    const input: p.PairRequest = { protocolVersion: 1, workerId: randomUUID(), requestId: randomUUID(), grant: grant.grant,
      workerToken: secret(), workerVersion: '0.1', capabilities: ['control-v1'] };
    const attempts = await Promise.allSettled([pairWorker(db, input, options),
      pairWorker(other, { ...input, workerId: randomUUID(), workerToken: secret() }, options)]);
    expect(attempts.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(await db.select().from(workers)).toHaveLength(1);
    const expiring = await createPairing(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, label: 'Host' }, options);
    now = expiring.expiresAt;
    await expect(pairWorker(db, { ...input, grant: expiring.grant }, options)).rejects.toMatchObject({ status: 401 });
    await expect(revokePairing(db, 'bob', grant.pairingId, revision(2), options)).rejects.toMatchObject({ status: 404 });
  });
  it('rechecks allowlist, verified owner and credential binding, but does not bind browser sessions', async () => {
    const { worker, run } = await prepared();
    const lease = await claim(worker.token);
    await db.update(account).set({ password: secret() }).where(eq(account.userId, 'alice'));
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ status: 401 });
    expect((await db.select().from(workers))[0].revokedAt).toBe(now);
    expect((await db.select().from(applicationRuns).where(eq(applicationRuns.id, run.id)))[0].state).toBe('paused');
    expect((await db.select().from(applications))[0].leaseUntil).toBeNull();
    const next = await paired();
    await expect(pollWorker(db, next.token, { protocolVersion: 1 }, { ...options, isAllowedApplicant: () => false }))
      .rejects.toMatchObject({ status: 401 });
    const third = await paired('bob');
    await db.update(user).set({ emailVerified: false }).where(eq(user.id, 'bob'));
    await expect(pollWorker(db, third.token, { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 401 });
    await expect(pollWorker(db, secret(), { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 401 });
  });
  it('revokes/removes pairing durably with exact command replay and owner isolation', async () => {
    const worker = await paired();
    const command = revision(2);
    const revoked = await revokePairing(db, 'alice', worker.grant.pairingId, command, options);
    expect(await revokePairing(other, 'alice', worker.grant.pairingId, command, options)).toEqual(revoked);
    await expect(pairWorker(db, worker.input, options)).rejects.toMatchObject({ status: 401 });
    await expect(pollWorker(db, worker.token, { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 401 });
    expect((await listWorkers(db, 'bob', options)).workers).toEqual([]);
    const current = await paired();
    await expect(revokeWorker(db, 'bob', current.workerId, revision(1), options)).rejects.toMatchObject({ status: 404 });
    expect((await listWorkers(db, 'alice', options)).workers.find((w) => w.id === current.workerId)?.online).toBe(true);
    now += p.HEARTBEAT_MS * 3;
    expect((await listWorkers(db, 'alice', options)).workers.find((w) => w.id === current.workerId)?.online).toBe(false);
  });
});
describe('async leases, checkpoints and stable identity', () => {
  it('reclaims one active lease before assigning another role to the same worker', async () => {
    const worker = await paired();
    const run = await createRun(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, workerId: worker.workerId }, options);
    const first = await enqueueApplication(db, 'alice', run.id,
      { ats: 'fixture', tenant: 'first', requisition: 'one' }, options);
    const second = await enqueueApplication(db, 'alice', run.id,
      { ats: 'fixture', tenant: 'second', requisition: 'two' }, options);
    const lease = await claim(worker.token);
    const waiting = lease.applicationId === first.id ? second : first;
    const reclaimed = await claim(worker.token);
    expect(reclaimed.applicationId).toBe(lease.applicationId);
    expect(reclaimed.fence).toBeGreaterThan(lease.fence);
    expect((await db.select().from(applications).where(eq(applications.id, waiting.id)))[0].state).toBe('queued');
    await recordWorkerEvent(db, worker.token, reclaimed.applicationId,
      { ...event(reclaimed, 'skipped'), reasonCode: 'fixture_ineligible' }, options);
    expect((await claim(worker.token)).applicationId).toBe(waiting.id);
  });
  it.each(['paused', 'obsolete-policy', 'busy-tenant'] as const)(
    'finds runnable work beyond 250 %s candidates with tied creation times', async (reason) => {
      const worker = await paired();
      const blocked = await createRun(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, workerId: worker.workerId }, options);
      // Stable IDs make the runnable row last even when every creation time ties.
      await db.insert(applications).values(Array.from({ length: 250 }, (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        ownerId: 'alice', runId: blocked.id, workerId: worker.workerId, ats: 'fixture',
        tenant: 'blocked', requisition: `blocked-${index}`, availableAt: now, createdAt: now,
      })));
      if (reason === 'paused') await commandRun(db, 'alice', blocked.id, { ...revision(1), action: 'pause' }, options);
      if (reason === 'obsolete-policy') await db.update(policyHeads).set({ revision: 3 }).where(eq(policyHeads.ownerId, 'alice'));
      if (reason === 'busy-tenant') {
        const busy = await prepared('alice', 'blocked');
        await claim(busy.worker.token);
      }
      const run = await createRun(db, 'alice', { requestId: randomUUID(), expectedRevision: 0, workerId: worker.workerId }, options);
      const runnable = await enqueueApplication(db, 'alice', run.id,
        { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, options);
      expect(await db.select().from(applications).where(eq(applications.workerId, worker.workerId))).toHaveLength(251);
      const lease = await claim(worker.token);
      expect(lease).toMatchObject({ applicationId: runnable.id, runId: run.id, state: 'screening', mode: 'safe',
        policyRevision: reason === 'obsolete-policy' ? 3 : 1 });
      await recordWorkerEvent(db, worker.token, runnable.id,
        { ...event(lease, 'blocked_unsupported'), reasonCode: 'adapter_unavailable' }, options);
      expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    });
  it('defers abandoned unknown reconciliation durably on next poll and frees unrelated work without retrying', async () => {
    const { worker, app, run } = await prepared();
    const initial = await claim(worker.token), input = event(initial);
    const saved = await recordWorkerEvent(db, worker.token, app.id, input, options);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    now += p.LEASE_MS;
    const unknown = await claim(worker.token);
    expect(unknown).toMatchObject({ state: 'submission_unknown', mode: 'reconcile', checkpoint: { sequence: 1 } });
    const unrelated = await enqueueApplication(db, 'alice', run.id,
      { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, options);
    const next = await claim(worker.token);
    expect(next.applicationId).toBe(unrelated.id);
    const [deferred] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(deferred).toMatchObject({ state: 'submission_unknown', leaseUntil: null, leaseCheckedAt: null,
      revision: unknown.revision + 1, fence: unknown.fence + 1, checkpoint: unknown.checkpoint, retries: 0,
      reasonCode: 'reconciliation_deferred' });
    expect(deferred.availableAt).toBeGreaterThan(now + p.HEARTBEAT_MS);
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(unknown) }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(recordWorkerEvent(db, worker.token, app.id,
      { ...event(unknown), checkpoint: { stage: 'ready', sequence: 2 } }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(submitIntent(db, worker.token, app.id,
      { protocolVersion: 1, eventId: randomUUID(), fence: unknown.fence, expectedRevision: unknown.revision }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    for (const action of ['retry-safe', 'cancel', 'skip'] as const) {
      await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(deferred.revision), action }, options))
        .rejects.toMatchObject({ status: 409 });
    }
    expect(await recordWorkerEvent(db, worker.token, app.id, input, options))
      .toMatchObject({ revision: saved.revision, replayed: true, lease: null });
    await recordWorkerEvent(db, worker.token, unrelated.id,
      { ...event(next, 'blocked_unsupported'), reasonCode: 'adapter_unavailable' }, options);
    db.$client.close();
    db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    now = deferred.availableAt - 1;
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0]).toEqual(deferred);
    now += 1;
    const reconciled = await claim(worker.token);
    expect(reconciled).toMatchObject({ applicationId: app.id, state: 'submission_unknown', mode: 'reconcile',
      checkpoint: unknown.checkpoint, fence: deferred.fence + 1 });
    expect(await db.select().from(applicationEvents)).toHaveLength(2);
  });
  it('another worker poll cannot defer an active unknown assignment', async () => {
    const { worker, app } = await prepared();
    await db.update(applications).set({ state: 'submission_unknown' }).where(eq(applications.id, app.id));
    const unknown = await claim(worker.token);
    const otherWorker = await prepared('alice', 'unrelated');
    expect((await claim(otherWorker.worker.token)).applicationId).toBe(otherWorker.app.id);
    expect((await heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(unknown) }, options)).lease)
      .toMatchObject({ applicationId: app.id, state: 'submission_unknown', fence: unknown.fence, revision: unknown.revision });
  });
  it('does not cycle deferred unknowns ahead of runnable work when backoffs expire', async () => {
    const { worker, run, app } = await prepared('alice', 'unrelated');
    await db.insert(applications).values(Array.from({ length: 8 }, (_, index) => ({
      id: randomUUID(), ownerId: 'alice', runId: run.id, workerId: worker.workerId, ats: 'fixture',
      tenant: `unknown-${index}`, requisition: 'unknown', state: 'submission_unknown' as const,
      availableAt: now - 8 + index, createdAt: now - 8 + index,
    })));
    const seen = [];
    for (let attempt = 0; attempt < 9; attempt++) {
      const lease = await claim(worker.token);
      seen.push(lease.applicationId);
      if (lease.applicationId === app.id) break;
      expect(lease).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
      now += p.HEARTBEAT_MS;
    }
    expect(seen).toContain(app.id);
    expect(new Set(seen).size).toBe(seen.length);
  });
  it('allows exactly one selected worker and one active owner/ATS/tenant across connections', async () => {
    const a = await prepared(), b = await prepared();
    const results = await Promise.all([pollWorker(db, a.worker.token, { protocolVersion: 1 }, options),
      pollWorker(other, b.worker.token, { protocolVersion: 1 }, options)]);
    expect(results.filter((r) => r.lease !== null)).toHaveLength(1);
    expect(await db.select().from(applications).where(sql`${applications.leaseUntil} is not null`)).toHaveLength(1);
    const active = results.find((r) => r.lease)!.lease!;
    const loser = active.workerId === a.worker.workerId ? b : a;
    await expect(recordWorkerEvent(db, loser.worker.token, active.applicationId, event(active), options)).rejects.toMatchObject({ status: 404 });
    const bob = await prepared('bob');
    expect((await claim(bob.worker.token)).applicationId).toBe(bob.app.id);
  });
  it('deduplicates owner+ATS+tenant+requisition across runs without transferring the selected worker', async () => {
    const a = await prepared('alice', 'fixture', 'stable-role');
    const b = await paired();
    const run = await createRun(db, 'alice', { expectedRevision: 0, requestId: randomUUID(), workerId: b.workerId }, options);
    const duplicate = await enqueueApplication(other, 'alice', run.id, { ats: 'fixture', tenant: 'fixture', requisition: 'stable-role' }, options);
    expect(duplicate).toEqual(a.app);
    expect((await pollWorker(db, b.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    await expect(db.update(applications).set({ workerId: b.workerId }).where(eq(applications.id, a.app.id))).rejects.toThrow();
    await expect(db.insert(applications).values({ id: randomUUID(), ownerId: 'bob', runId: run.id, workerId: b.workerId,
      ats: 'fixture', tenant: 'test', requisition: 'test', availableAt: now, createdAt: now })).rejects.toThrow();
  });
  it.each(SAFE_STAGES)('reopens and reclaims %s without duplicate events; stale fences lose authority', async (stage) => {
    const { worker, app } = await prepared();
    // Fault injection at a persisted future stage, not an execution path or public test route.
    await db.update(applications).set({ state: stage }).where(eq(applications.id, app.id));
    const lease = await claim(worker.token), input = event(lease);
    const saved = await recordWorkerEvent(db, worker.token, app.id, input, options);
    expect(saved.replayed).toBe(false);
    db.$client.close();
    db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    const replay = await recordWorkerEvent(db, worker.token, app.id, input, options);
    expect(replay).toMatchObject({ revision: saved.revision, replayed: true, lease: null });
    const restarted = await claim(worker.token);
    expect(restarted.fence).toBeGreaterThan(lease.fence);
    expect(restarted.checkpoint?.sequence).toBe(1);
    await expect(heartbeatWorker(other, worker.token, { protocolVersion: 1, lease: ref(saved.lease!) }, options))
      .rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(recordWorkerEvent(db, worker.token, app.id, { ...input, state: 'needs_answer' }, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(applicationEvents)).toHaveLength(1);
    await expect(db.delete(applicationEvents)).rejects.toThrow();
  });
  it('releases waiting slots and resumes only explicit bounded safe retries after backoff', async () => {
    const a = await prepared(), b = await prepared();
    const first = await claim(a.worker.token);
    const blocked = await recordWorkerEvent(db, a.worker.token, a.app.id, { ...event(first, 'retryable_failure'), reasonCode: 'fixture_unavailable' }, options);
    expect(blocked.lease).toBeNull();
    expect((await claim(b.worker.token)).applicationId).toBe(b.app.id);
    const retry = await commandApplication(db, 'alice', a.run.id, a.app.id, { ...revision(blocked.revision), action: 'retry-safe' }, options);
    expect(retry.state).toBe('screening');
    expect((await pollWorker(db, a.worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    now += 5000;
    await commandApplication(db, 'alice', b.run.id, b.app.id, { ...revision((await listRuns(db, 'alice')).applications.find((v) => v.id === b.app.id)!.revision), action: 'skip' }, options);
    expect((await claim(a.worker.token)).applicationId).toBe(a.app.id);
  });
  it.each(['expiry', 'clock-backward', 'policy-disabled', 'policy-reenabled'] as const)('invalidates heartbeat at %s and commits release before returning the error', async (reason) => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    if (reason === 'expiry') now += p.LEASE_MS;
    if (reason === 'clock-backward') now -= 1;
    if (reason === 'policy-disabled') await db.update(policyHeads).set({ enabled: false, acceptedPolicyHash: null, acceptedPolicyVersion: null, acceptedAt: null });
    if (reason === 'policy-reenabled') await db.update(policyHeads).set({ revision: 3 });
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const [row] = await db.select().from(applications).where(eq(applications.id, app.id));
    expect(row.leaseUntil).toBeNull();
    expect(row.fence).toBeGreaterThan(lease.fence);
  });
  it('same-content policy re-enable cannot restore an old run at event, claim or resume', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token);
    expect(lease).toMatchObject({ ownerId: 'alice', policyRevision: 1 });
    const [accepted] = await db.select().from(policyHeads).where(eq(policyHeads.ownerId, 'alice'));
    await db.update(policyHeads).set({ enabled: false, revision: 2, acceptedPolicyHash: null,
      acceptedPolicyVersion: null, acceptedAt: null }).where(eq(policyHeads.ownerId, 'alice'));
    await db.update(policyHeads).set({ ...accepted, revision: 3 }).where(eq(policyHeads.ownerId, 'alice'));
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    const paused = await commandRun(db, 'alice', run.id, { ...revision(run.revision), action: 'pause' }, options);
    await expect(commandRun(db, 'alice', run.id, { ...revision(paused.revision), action: 'resume' }, options))
      .rejects.toMatchObject({ status: 403 });
    const freshRun = await createRun(db, 'alice', { expectedRevision: 0, requestId: randomUUID(), workerId: worker.workerId }, options);
    await enqueueApplication(db, 'alice', freshRun.id, { ats: 'fixture', tenant: 'fixture', requisition: 'new-role' }, options);
    expect(await claim(worker.token)).toMatchObject({ runId: freshRun.id, policyRevision: 3 });
  });
  it('expired submitting becomes read-only unknown, never a fresh submit or retry', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    now += p.LEASE_MS + 1;
    const unknown = await claim(worker.token);
    expect(unknown).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(commandApplication(db, 'alice', run.id, app.id, { ...revision(unknown.revision), action: 'retry-safe' }, options)).rejects.toMatchObject({ status: 409 });
    await expect(submitIntent(db, worker.token, app.id, { protocolVersion: 1, eventId: randomUUID(), fence: unknown.fence, expectedRevision: unknown.revision }, options)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    await expect(db.update(applications).set({ state: 'queued' }).where(eq(applications.id, app.id))).rejects.toThrow();
  });
  it('unknown reconciliation after stop and policy disable cannot checkpoint any state or emit a receipt', async () => {
    const { worker, app, run } = await prepared();
    await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    await commandRun(db, 'alice', run.id, { ...revision(run.revision), action: 'stop' }, options);
    await db.update(policyHeads).set({ enabled: false, revision: 2, acceptedPolicyHash: null,
      acceptedPolicyVersion: null, acceptedAt: null }).where(eq(policyHeads.ownerId, 'alice'));
    const lease = await claim(worker.token);
    expect(lease).toMatchObject({ state: 'submission_unknown', mode: 'reconcile' });
    const heartbeat = await heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options);
    expect(heartbeat.lease).toMatchObject({ mode: 'reconcile', fence: lease.fence, revision: lease.revision });
    for (const state of APPLICATION_STATES) {
      await expect(recordWorkerEvent(db, worker.token, app.id, {
        ...event(lease, state), checkpoint: { stage: 'ready', sequence: 1 },
      }, options)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    }
    await expect(submitIntent(db, worker.token, app.id, { protocolVersion: 1, eventId: randomUUID(),
      fence: lease.fence, expectedRevision: lease.revision }, options)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
    expect((await db.select().from(applications).where(eq(applications.id, app.id)))[0])
      .toMatchObject({ state: 'submission_unknown', revision: lease.revision, fence: lease.fence });
  });
  it('rejects unsupported future evidence paths and stale zero-row checkpoints', async () => {
    const { worker, app } = await prepared();
    const first = await claim(worker.token);
    const tailored = await recordWorkerEvent(db, worker.token, app.id, {
      ...event(first, 'tailoring'), checkpoint: { stage: 'tailoring', sequence: 1 },
    }, options);
    await expect(recordWorkerEvent(db, worker.token, app.id, {
      ...event(tailored.lease!, 'filling'), checkpoint: { stage: 'filling', sequence: 2 },
    }, options)).rejects.toMatchObject({ code: 'EXECUTION_DISABLED' });
    await expect(recordWorkerEvent(db, worker.token, app.id, event(first), options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
  });
  it('caps retry-safe at three, rejects unresolved-answer retries, and preserves command idempotency', async () => {
    const { worker, app, run } = await prepared();
    for (let attempt = 0; attempt <= 3; attempt++) {
      const lease = await claim(worker.token);
      const blocked = await recordWorkerEvent(db, worker.token, app.id, {
        ...event(lease, 'retryable_failure'), reasonCode: 'fixture_retry',
      }, options);
      const command = { ...revision(blocked.revision), action: 'retry-safe' as const };
      if (attempt === 3) {
        await expect(commandApplication(db, 'alice', run.id, app.id, command, options)).rejects.toMatchObject({ status: 409 });
      } else {
        const retried = await commandApplication(db, 'alice', run.id, app.id, command, options);
        expect(await commandApplication(other, 'alice', run.id, app.id, command, options)).toEqual(retried);
        now += 5000 * 2 ** attempt;
      }
    }
    const next = await prepared('alice', 'other-tenant');
    const lease = await claim(next.worker.token);
    const blocked = await recordWorkerEvent(db, next.worker.token, next.app.id, {
      ...event(lease, 'needs_answer'), reasonCode: 'required_answer',
    }, options);
    await expect(commandApplication(db, 'alice', next.run.id, next.app.id,
      { ...revision(blocked.revision), action: 'retry-safe' }, options)).rejects.toMatchObject({ status: 409 });
    // Forms parked by the removed fill/inspect gate retry from their checkpoint; real verification holds do not.
    for (const [reasonCode, allowed] of [['provider_inspect_required', true], ['captcha_required', false]] as const) {
      const parked = await prepared('alice', `parked-${reasonCode}`);
      const held = await recordWorkerEvent(db, parked.worker.token, parked.app.id, {
        ...event(await claim(parked.worker.token), 'needs_verification'), reasonCode,
      }, options);
      const retry = commandApplication(db, 'alice', parked.run.id, parked.app.id, { ...revision(held.revision), action: 'retry-safe' }, options);
      if (allowed) expect(await retry).toMatchObject({ state: 'screening' });
      else await expect(retry).rejects.toMatchObject({ status: 409 });
    }
  });
  it('revocation commits unknown submission and permanently rejects all subsequent token operations', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    const command = revision(1);
    const revoked = await revokeWorker(db, 'alice', worker.workerId, command, options);
    expect(await revokeWorker(other, 'alice', worker.workerId, command, options)).toEqual(revoked);
    const current = (await listRuns(db, 'alice')).applications.find((row) => row.id === app.id)!;
    expect(current.state).toBe('submission_unknown');
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ status: 401 });
    await expect(commandRun(db, 'alice', run.id, { ...revision(2), action: 'resume' }, options)).rejects.toMatchObject({ status: 403 });
    const replacement = await paired();
    expect((await pollWorker(db, replacement.token, { protocolVersion: 1 }, options)).lease).toBeNull();
  });
});
describe('zero-row writes cannot acknowledge authority', () => {
  it('rolls back unknown release and next claim if the durable backoff write is ignored', async () => {
    const { worker, app, run } = await prepared();
    await db.update(applications).set({ state: 'submission_unknown' }).where(eq(applications.id, app.id));
    await claim(worker.token);
    await enqueueApplication(db, 'alice', run.id, { ats: 'fixture', tenant: 'unrelated', requisition: 'runnable' }, options);
    const before = await db.select().from(applications);
    await db.run(sql.raw('CREATE TRIGGER fixture_ignore BEFORE UPDATE OF available_at ON private_application BEGIN SELECT RAISE(IGNORE); END'));
    await expect(pollWorker(db, worker.token, { protocolVersion: 1 }, options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(applications)).toEqual(before);
  });
  it.each(['private_application', 'private_application_event'] as const)('rolls back checkpoint when %s ignores its write', async (table) => {
    const { worker, app } = await prepared();
    const lease = await claim(worker.token);
    const before = await db.select().from(applications);
    const operation = table === 'private_application' ? 'UPDATE' : 'INSERT';
    await db.run(sql.raw(`CREATE TRIGGER fixture_ignore BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`));
    await expect(recordWorkerEvent(db, worker.token, app.id, event(lease), options)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(applications)).toEqual(before);
    expect(await db.select().from(applicationEvents)).toHaveLength(0);
  });
  it.each(['private_worker', 'private_worker_pairing', 'private_application_run', 'private_application', 'private_worker_command'] as const)(
    'rolls back revocation when %s ignores its write', async (table) => {
      const { worker } = await prepared();
      await claim(worker.token);
      const before = [await db.select().from(workers), await db.select().from(workerPairings),
        await db.select().from(applicationRuns), await db.select().from(applications)];
      const operation = table === 'private_worker_command' ? 'INSERT' : 'UPDATE';
      await db.run(sql.raw(`CREATE TRIGGER fixture_ignore BEFORE ${operation} ON ${table} BEGIN SELECT RAISE(IGNORE); END`));
      await expect(revokeWorker(db, 'alice', worker.workerId, revision(1), options)).rejects.toMatchObject({ status: 409 });
      expect([await db.select().from(workers), await db.select().from(workerPairings),
        await db.select().from(applicationRuns), await db.select().from(applications)]).toEqual(before);
      expect(await db.select().from(workerCommands)).toHaveLength(1); // Only run creation.
    });
});
describe('durable owner controls', () => {
  it('persists pause/resume/stop with command replay, conflicts and no destructive withdrawal claims', async () => {
    const { worker, app, run } = await prepared();
    const lease = await claim(worker.token), pause = { ...revision(1), action: 'pause' as const };
    const paused = await commandRun(db, 'alice', run.id, pause, options);
    expect(await commandRun(other, 'alice', run.id, pause, options)).toEqual(paused);
    expect((await pollWorker(db, worker.token, { protocolVersion: 1 }, options)).lease).toBeNull();
    await expect(heartbeatWorker(db, worker.token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(commandRun(db, 'bob', run.id, { ...revision(paused.revision), action: 'resume' }, options)).rejects.toMatchObject({ status: 404 });
    const resumed = await commandRun(db, 'alice', run.id, { ...revision(paused.revision), action: 'resume' }, options);
    expect((await claim(worker.token)).applicationId).toBe(app.id);
    const stopped = await commandRun(db, 'alice', run.id, { ...revision(resumed.revision), action: 'stop' }, options);
    expect(stopped.state).toBe('stopped');
    expect((await listRuns(db, 'alice')).applications[0].state).toBe('cancelled');
    await expect(commandRun(db, 'alice', run.id, { ...revision(stopped.revision), action: 'resume' }, options)).rejects.toMatchObject({ status: 409 });
    await expect(db.delete(workerCommands)).rejects.toThrow();
  });
  it('serializes command races and preserves unknown when emergency stop races submission', async () => {
    const { worker, run, app } = await prepared();
    await claim(worker.token);
    await db.update(applications).set({ state: 'submitting' }).where(eq(applications.id, app.id));
    const outcomes = await Promise.allSettled([
      commandRun(db, 'alice', run.id, { ...revision(1), action: 'emergency-stop' }, options),
      commandRun(other, 'alice', run.id, { ...revision(1), action: 'pause' }, options),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((await listRuns(db, 'alice')).applications[0].state).toBe('submission_unknown');
    expect((await claim(worker.token)).mode).toBe('reconcile');
  });
});
