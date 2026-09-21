import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationReceipts, applicationRuns, applications, applicationSubmissions, discoveryManifests, workers } from '../private-db/schema.ts';
import { getPolicy } from './stores.ts';
import { isTerminalState } from './state.ts';
import {
  RunCreateSchema, RunCommandSchema, ApplicationCommandSchema, ApplicationIdentitySchema,
  type RunCreate, type RunCommand, type ApplicationCommand, type ApplicationIdentity, type Run,
  type RunList, type ApplicationSummary,
} from './worker-protocol.ts';
import {
  workerTransaction, currentWorker, nowAt, one, fail, randomUUID, replayCommand, saveCommand,
  releaseApplication, appScope, WorkerError, type WorkerOptions, type ApplicationRow, type WorkerTx,
} from './worker-store.ts';

export const runSummary = ({ id, workerId, revision, state, createdAt }: typeof applicationRuns.$inferSelect): Run =>
  ({ id, workerId, revision, state, createdAt });
export const applicationSummary = ({ id, runId, workerId, ats, tenant, requisition, state, revision, reasonCode, checkpoint }: ApplicationRow,
  meta: { company?: string | null; role?: string | null; receiptId?: string | null; submittedAt?: number | null } = {}): ApplicationSummary =>
  ({ id, runId, workerId, ats, tenant, requisition, state, revision, reasonCode, checkpoint,
    company: meta.company ?? null, role: meta.role ?? null, receiptId: meta.receiptId ?? null, submittedAt: meta.submittedAt ?? null,
    provider: null, costUsd: null });

export async function createRun(db: PrivateDb, ownerId: string, input: RunCreate, options: WorkerOptions = {}): Promise<Run> {
  const command = RunCreateSchema.parse(input);
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<Run>(tx, ownerId, 'run:create', command);
    if (replay) return replay;
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, command.workerId)));
    if (!worker) fail(404, 'NOT_FOUND', 'Worker not found.');
    if (!await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
    const now = nowAt(options), policy = await getPolicy(tx, ownerId, now);
    if (!policy.enabled || !policy.policyHash) fail(403, 'FORBIDDEN', 'An enabled current policy is required.');
    const row = one(await tx.insert(applicationRuns).values({
      id: randomUUID(), ownerId, workerId: worker.id, policyRevision: policy.revision,
      policyVersion: policy.policyVersion, policyHash: policy.policyHash, createdAt: now,
    }).returning());
    const acknowledgement = runSummary(row);
    await saveCommand(tx, ownerId, 'run:create', command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
export async function listRuns(db: PrivateDb, ownerId: string): Promise<RunList> {
  return workerTransaction(db, async (tx) => ({
    ownerId,
    runs: (await tx.select().from(applicationRuns).where(eq(applicationRuns.ownerId, ownerId))
      .orderBy(desc(applicationRuns.createdAt)).limit(100)).map(runSummary),
    applications: (await tx.select({ app: applications, submission: applicationSubmissions, receipt: applicationReceipts })
      .from(applications)
      .leftJoin(applicationSubmissions, and(eq(applicationSubmissions.ownerId, applications.ownerId), eq(applicationSubmissions.applicationId, applications.id)))
      .leftJoin(applicationReceipts, and(eq(applicationReceipts.ownerId, applications.ownerId), eq(applicationReceipts.applicationId, applications.id)))
      .where(eq(applications.ownerId, ownerId)).orderBy(desc(applications.createdAt)).limit(100))
      .map(({ app, submission, receipt }) => applicationSummary(app, {
        company: submission?.company ?? receipt?.company, role: submission?.role ?? receipt?.role,
        receiptId: receipt?.receiptId, submittedAt: receipt?.submittedAt,
      })),
  }));
}
export async function releaseRunApplications(tx: WorkerTx, ownerId: string, runId: string, state: 'paused' | 'stopped') {
  for (const app of await tx.select().from(applications).where(and(eq(applications.ownerId, ownerId), eq(applications.runId, runId)))) {
    if (isTerminalState(app.state)) continue;
    const released = await releaseApplication(tx, app, state === 'paused' ? 'run_paused' : 'run_stopped');
    if (state === 'stopped' && released.state !== 'submission_unknown') {
      one(await tx.update(applications).set({ state: 'cancelled' }).where(and(
        appScope(ownerId, app.id), eq(applications.revision, released.revision),
      )).returning());
    }
  }
}
export async function commandRun(db: PrivateDb, ownerId: string, id: string, input: RunCommand, options: WorkerOptions = {}): Promise<Run> {
  const command = RunCommandSchema.parse(input), scope = `run:${id}`;
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<Run>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [row] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, id)));
    if (!row) fail(404, 'NOT_FOUND', 'Run not found.');
    if (row.revision !== command.expectedRevision || row.state === 'stopped') fail();
    const now = nowAt(options);
    if (command.action === 'resume') {
      if (row.state !== 'paused') fail();
      const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, row.workerId)));
      if (!worker || !await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
      const policy = await getPolicy(tx, ownerId, now);
      if (!policy.enabled || policy.revision !== row.policyRevision || policy.policyVersion !== row.policyVersion || policy.policyHash !== row.policyHash) {
        fail(403, 'FORBIDDEN', 'Run policy is no longer enabled.');
      }
    }
    const state = command.action === 'resume' ? 'running' : command.action === 'pause' ? 'paused' : 'stopped';
    const incomplete = row.discoveryState === 'capturing' || row.discoveryState === 'staging';
    const updated = one(await tx.update(applicationRuns).set({
      state, revision: row.revision + 1,
      ...(state === 'stopped' ? { captureToken: null, captureUntil: null,
        ...(incomplete ? { discoveryState: 'abandoned' as const } : {}) } : {}),
    })
      .where(and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, id), eq(applicationRuns.revision, row.revision))).returning());
    if (state === 'stopped' && row.discoveryState === 'staging' && row.currentManifestId) {
      one(await tx.update(discoveryManifests).set({ state: 'abandoned', revision: sql`${discoveryManifests.revision} + 1` })
        .where(and(eq(discoveryManifests.ownerId, ownerId), eq(discoveryManifests.id, row.currentManifestId),
          eq(discoveryManifests.runId, id), eq(discoveryManifests.state, 'staging'))).returning());
    }
    if (state !== 'running') await releaseRunApplications(tx, ownerId, id, state);
    const acknowledgement = runSummary(updated);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
export async function commandApplication(
  db: PrivateDb, ownerId: string, runId: string, id: string, input: ApplicationCommand, options: WorkerOptions = {},
): Promise<ApplicationSummary> {
  const command = ApplicationCommandSchema.parse(input), scope = `application:${runId}:${id}`;
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ApplicationSummary>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [row] = await tx.select().from(applications).where(and(appScope(ownerId, id), eq(applications.runId, runId)));
    if (!row) fail(404, 'NOT_FOUND', 'Application not found.');
    if (row.revision !== command.expectedRevision || isTerminalState(row.state)) fail();
    const now = nowAt(options);
    const ambiguous = row.state === 'submitting' || row.state === 'submission_unknown';
    if (ambiguous && command.action !== 'emergency-stop') fail(409, 'CONFLICT', 'Submission requires read-only reconciliation.');
    let next = row.state, availableAt = row.availableAt, retries = row.retries;
    if (command.action === 'retry-safe') {
      const [run] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.id, runId), eq(applicationRuns.ownerId, ownerId)));
      if (!run || run.state === 'stopped' || !['provider_unavailable', 'retryable_failure'].includes(row.state) ||
          !row.checkpoint || row.retries >= 3) fail(409, 'CONFLICT', 'No safe retry is available.');
      next = row.checkpoint.stage; retries += 1; availableAt = now + 5000 * 2 ** row.retries;
    } else next = ambiguous ? 'submission_unknown' : command.action === 'skip' ? 'skipped' : 'cancelled';
    const updated = one(await tx.update(applications).set({
      state: next, revision: row.revision + 1, fence: row.fence + 1, leaseUntil: null, leaseCheckedAt: null,
      reasonCode: command.action, availableAt, retries,
    }).where(and(appScope(ownerId, id), eq(applications.revision, row.revision), eq(applications.fence, row.fence))).returning());
    const acknowledgement = applicationSummary(updated);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
}
/** Private DAL only. Phase 4 owns real corpus discovery; there is no public enqueue route. */
export async function enqueueApplication(
  db: PrivateDb, ownerId: string, runId: string, input: ApplicationIdentity, options: WorkerOptions = {},
): Promise<ApplicationSummary> {
  const identity = ApplicationIdentitySchema.parse(input);
  return workerTransaction(db, async (tx) => {
    const [run] = await tx.select().from(applicationRuns).where(and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, runId)));
    if (!run || run.state !== 'running') fail(404, 'NOT_FOUND', 'Running application run not found.');
    const now = nowAt(options);
    await tx.insert(applications).values({
      id: randomUUID(), ownerId, runId, workerId: run.workerId, ...identity, availableAt: now, createdAt: now,
    }).onConflictDoNothing({ target: [applications.ownerId, applications.ats, applications.tenant, applications.requisition, applications.attempt] });
    const [row] = await tx.select().from(applications).where(and(
      eq(applications.ownerId, ownerId), eq(applications.ats, identity.ats),
      eq(applications.tenant, identity.tenant), eq(applications.requisition, identity.requisition),
    )).orderBy(desc(applications.attempt)).limit(1);
    return applicationSummary(one(row ? [row] : []));
  });
}
