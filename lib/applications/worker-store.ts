import 'server-only';
import { and, eq, sql } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { getAuth } from '../auth.ts';
import type { PrivateDb } from '../private-db/index.ts';
import { account, applications, applicationRuns, discoveryManifests, manualApplicationMarks, user, workers, workerCommands, workerPairings } from '../private-db/schema.ts';
import { hashValue, getPolicy } from './stores.ts';
import { HEARTBEAT_MS, LEASE_MS, WORKER_PROTOCOL_VERSION, type Lease } from './worker-protocol.ts';

export type WorkerOptions = { now?: () => number; isAllowedApplicant?: (email: string) => boolean };
export type WorkerTx = Parameters<Parameters<PrivateDb['transaction']>[0]>[0];
export type WorkerRow = typeof workers.$inferSelect;
export type ApplicationRow = typeof applications.$inferSelect;
export class WorkerError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export function fail(status = 409, code = 'CONFLICT', message = 'Revision or request conflict.'): never {
  throw new WorkerError(status, code, message);
}
export const nowAt = (options: WorkerOptions) => (options.now ?? Date.now)();
export const secretHash = (value: string) => createHash('sha256').update(value).digest('hex');
export function one<T>(rows: T[]): T {
  if (rows.length !== 1) fail();
  return rows[0];
}
export async function workerTransaction<T>(db: PrivateDb, action: (tx: WorkerTx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      if (db.$client.protocol === 'file') await db.run(sql`pragma journal_mode = WAL`);
      return await db.transaction(action);
    } catch (error) {
      let cause: unknown = error;
      while (cause && typeof cause === 'object' && !('code' in cause) && 'cause' in cause) cause = cause.cause;
      if (attempt >= 3 || !cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'SQLITE_BUSY') throw error;
      await new Promise((resolve) => setTimeout(resolve, 10 * 3 ** attempt));
    }
  }
}
export async function credentialBinding(tx: WorkerTx, ownerId: string, options: WorkerOptions): Promise<string | null> {
  const rows = await tx.select({
    email: user.email, verified: user.emailVerified, accountId: account.id, password: account.password,
  }).from(user).innerJoin(account, and(eq(account.userId, user.id), eq(account.providerId, 'credential')))
    .where(eq(user.id, ownerId));
  if (rows.length !== 1 || !rows[0].verified || !rows[0].password ||
      !(options.isAllowedApplicant ?? getAuth().isAllowedApplicant)(rows[0].email)) return null;
  return hashValue([rows[0].accountId, rows[0].password]);
}
export const appScope = (ownerId: string, id: string) => and(eq(applications.ownerId, ownerId), eq(applications.id, id));
export async function releaseApplication(tx: WorkerTx, row: ApplicationRow, reasonCode: string) {
  return one(await tx.update(applications).set({
    state: row.state === 'submitting' ? 'submission_unknown' : row.state,
    leaseUntil: null, leaseCheckedAt: null, fence: row.fence + 1, revision: row.revision + 1, reasonCode,
  }).where(and(appScope(row.ownerId, row.id), eq(applications.revision, row.revision), eq(applications.fence, row.fence))).returning());
}
export async function invalidatePairing(tx: WorkerTx, row: typeof workerPairings.$inferSelect, now: number) {
  if (row.revokedAt === null) one(await tx.update(workerPairings).set({ revokedAt: now, revision: row.revision + 1 })
    .where(and(eq(workerPairings.id, row.id), eq(workerPairings.ownerId, row.ownerId),
      eq(workerPairings.revision, row.revision))).returning());
}
export async function invalidateWorker(tx: WorkerTx, row: WorkerRow, now: number) {
  if (row.revokedAt === null) {
    one(await tx.update(workers).set({ revokedAt: now, revision: row.revision + 1 })
      .where(and(eq(workers.id, row.id), eq(workers.ownerId, row.ownerId), eq(workers.revision, row.revision))).returning());
  }
  const [pairing] = await tx.select().from(workerPairings).where(and(
    eq(workerPairings.id, row.pairingId), eq(workerPairings.ownerId, row.ownerId),
  ));
  if (pairing) await invalidatePairing(tx, pairing, now);
  const runs = await tx.select().from(applicationRuns).where(and(
    eq(applicationRuns.ownerId, row.ownerId), eq(applicationRuns.workerId, row.id), eq(applicationRuns.state, 'running'),
  ));
  for (const run of runs) one(await tx.update(applicationRuns).set({ state: 'paused', revision: run.revision + 1 })
    .where(and(eq(applicationRuns.ownerId, row.ownerId), eq(applicationRuns.id, run.id),
      eq(applicationRuns.revision, run.revision))).returning());
  const active = await tx.select().from(applications).where(and(
    eq(applications.ownerId, row.ownerId), eq(applications.workerId, row.id),
    sql`(${applications.leaseUntil} is not null or ${applications.state} = 'submitting')`,
  ));
  for (const app of active) await releaseApplication(tx, app, 'worker_revoked');
}
export async function currentWorker(tx: WorkerTx, row: WorkerRow, options: WorkerOptions): Promise<boolean> {
  const binding = await credentialBinding(tx, row.ownerId, options);
  const [pairing] = await tx.select().from(workerPairings).where(and(
    eq(workerPairings.id, row.pairingId), eq(workerPairings.ownerId, row.ownerId),
  ));
  if (row.revokedAt !== null || !binding || binding !== row.credentialBinding || !pairing ||
      pairing.revokedAt !== null || pairing.credentialBinding !== binding) {
    await invalidateWorker(tx, row, nowAt(options));
    return false;
  }
  return true;
}
export async function withWorker<T>(
  db: PrivateDb, token: string, options: WorkerOptions, action: (tx: WorkerTx, worker: WorkerRow, now: number) => Promise<T | WorkerError>,
): Promise<T> {
  const denied = new WorkerError(401, 'WORKER_UNAUTHORIZED', 'Worker authorization required.');
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw denied;
  const result = await workerTransaction(db, async (tx) => {
    const [worker] = await tx.select().from(workers).where(eq(workers.tokenHash, secretHash(token)));
    // Return the error so revocation commits; throwing here would roll it back.
    if (!worker || !await currentWorker(tx, worker, options)) return denied;
    return action(tx, worker, nowAt(options));
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
export async function liveRun(tx: WorkerTx, app: ApplicationRow, now: number) {
  const [run] = await tx.select().from(applicationRuns).where(and(
    eq(applicationRuns.ownerId, app.ownerId), eq(applicationRuns.id, app.runId), eq(applicationRuns.workerId, app.workerId),
  ));
  if (!run) return false;
  if (app.state === 'submission_unknown') return true;
  if (run.state !== 'running') return false;
  if (app.snapshotManifestId) {
    const [manifest] = await tx.select({ state: discoveryManifests.state }).from(discoveryManifests).where(and(
      eq(discoveryManifests.ownerId, app.ownerId), eq(discoveryManifests.id, app.snapshotManifestId),
    ));
    if (manifest?.state !== 'ready') return false;
  }
  const [manual] = await tx.select({ id: manualApplicationMarks.id }).from(manualApplicationMarks).where(and(
    eq(manualApplicationMarks.ownerId, app.ownerId), eq(manualApplicationMarks.ats, app.ats),
    eq(manualApplicationMarks.tenant, app.tenant), eq(manualApplicationMarks.requisition, app.requisition),
  )).limit(1);
  if (manual) return false;
  const policy = await getPolicy(tx, app.ownerId, now);
  return policy.enabled && policy.revision === run.policyRevision &&
    policy.policyVersion === run.policyVersion && policy.policyHash === run.policyHash;
}
export async function leaseOf(tx: WorkerTx, app: ApplicationRow): Promise<Lease> {
  if (app.leaseUntil === null) fail(409, 'LEASE_LOST', 'Lease is no longer valid.');
  const [run] = await tx.select().from(applicationRuns).where(and(
    eq(applicationRuns.ownerId, app.ownerId), eq(applicationRuns.id, app.runId), eq(applicationRuns.workerId, app.workerId),
  ));
  if (!run) fail(409, 'LEASE_LOST', 'Lease is no longer valid.');
  return {
    applicationId: app.id, runId: app.runId, workerId: app.workerId, ownerId: app.ownerId, policyRevision: run.policyRevision,
    ats: app.ats, tenant: app.tenant, requisition: app.requisition, state: app.state,
    revision: app.revision, fence: app.fence, leaseUntil: app.leaseUntil, checkpoint: app.checkpoint,
    mode: app.state === 'submission_unknown' || app.state === 'submitting' ? 'reconcile' : 'safe',
  };
}
export const clockResponse = (now: number) => ({
  protocolVersion: WORKER_PROTOCOL_VERSION, serverTime: now, heartbeatMs: HEARTBEAT_MS, leaseMs: LEASE_MS,
} as const);
export async function replayCommand<T>(tx: WorkerTx, ownerId: string, scope: string, input: { requestId: string }): Promise<T | undefined> {
  const [previous] = await tx.select().from(workerCommands).where(and(
    eq(workerCommands.ownerId, ownerId), eq(workerCommands.requestId, input.requestId),
  ));
  if (!previous) return;
  if (previous.requestHash !== hashValue([scope, input])) fail();
  return previous.acknowledgement as T;
}
export async function saveCommand(tx: WorkerTx, ownerId: string, scope: string, input: { requestId: string }, acknowledgement: unknown, now: number) {
  one(await tx.insert(workerCommands).values({
    ownerId, requestId: input.requestId, requestHash: hashValue([scope, input]), acknowledgement, createdAt: now,
  }).returning({ requestId: workerCommands.requestId }));
}
export { randomUUID };
