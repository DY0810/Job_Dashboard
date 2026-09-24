import 'server-only';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applications, workers } from '../private-db/schema.ts';
import { isTerminalState, isWaitingState } from './state.ts';
import { discoverWorkerRuns, discoveryClaimAllowed, type CorpusProvider } from './discovery.ts';
import {
  PollRequestSchema, HeartbeatRequestSchema, LEASE_MS,
  type PollRequest, type HeartbeatRequest, type PollResponse, type LeaseRef,
} from './worker-protocol.ts';
import {
  withWorker, appScope, releaseApplication, liveRun, leaseOf, clockResponse, one, fail,
  WorkerError, type WorkerOptions, type WorkerTx, type WorkerRow, type ApplicationRow,
} from './worker-store.ts';

export async function checkedLease(tx: WorkerTx, worker: WorkerRow, ref: LeaseRef, now: number) {
  const [app] = await tx.select().from(applications).where(and(appScope(worker.ownerId, ref.applicationId), eq(applications.workerId, worker.id)));
  if (!app || app.fence !== ref.fence || app.revision !== ref.expectedRevision ||
      app.leaseUntil === null || app.leaseCheckedAt === null) fail(409, 'LEASE_LOST', 'Lease is no longer valid.');
  if (now < app.leaseCheckedAt || app.leaseUntil <= now || !await liveRun(tx, app, now)) {
    await releaseApplication(tx, app, 'lease_lost');
    return new WorkerError(409, 'LEASE_LOST', 'Lease is no longer valid.');
  }
  return app;
}
export async function pollWorker(db: PrivateDb, token: string, input: PollRequest, options: WorkerOptions & { corpus?: CorpusProvider } = {}): Promise<PollResponse> {
  PollRequestSchema.parse(input);
  if (options.corpus) await discoverWorkerRuns(db, token, options.corpus, options);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const active = await tx.select().from(applications).where(and(eq(applications.ownerId, worker.ownerId), sql`${applications.leaseUntil} is not null`));
    let assigned: ApplicationRow | undefined;
    for (const app of active) {
      if (app.workerId === worker.id && app.state === 'submission_unknown') {
        // A new poll abandons this read-only assignment; heartbeat retains it instead.
        const released = await releaseApplication(tx, app, 'reconciliation_deferred');
        one(await tx.update(applications).set({ availableAt: now + LEASE_MS }).where(and(
          appScope(worker.ownerId, app.id), eq(applications.revision, released.revision),
          eq(applications.fence, released.fence),
        )).returning());
      } else if (app.leaseUntil! <= now || now < app.leaseCheckedAt! || !await liveRun(tx, app, now)) {
        await releaseApplication(tx, app, 'lease_expired');
      } else if (app.workerId === worker.id) {
        assigned ??= app;
      }
    }
    one(await tx.update(workers).set({ lastSeenAt: now }).where(and(
      eq(workers.id, worker.id), eq(workers.ownerId, worker.ownerId), eq(workers.revision, worker.revision),
    )).returning());
    // Resume safe assignments first, then oldest availability so deferred checks cannot starve ready work.
    let cursor: ApplicationRow | undefined;
    while (true) {
      const candidates: ApplicationRow[] = await tx.select().from(applications).where(and(
        eq(applications.ownerId, worker.ownerId), eq(applications.workerId, worker.id), sql`${applications.availableAt} <= ${now}`,
        assigned && eq(applications.id, assigned.id),
        sql`${applications.state} in ('queued','screening','tailoring','filling','ready','submitting','submission_unknown')`,
        cursor && sql`(${applications.leaseUntil} is null, ${applications.availableAt}, ${applications.createdAt}, ${applications.id}) >
          (${cursor.leaseUntil === null ? 1 : 0}, ${cursor.availableAt}, ${cursor.createdAt}, ${cursor.id})`,
      )).orderBy(sql`${applications.leaseUntil} is null`, asc(applications.availableAt), asc(applications.createdAt), asc(applications.id)).limit(100);
      for (const app of candidates) {
        if (!await liveRun(tx, app, now)) continue;
        const [busy] = await tx.select({ id: applications.id }).from(applications).where(and(
          eq(applications.ownerId, worker.ownerId), eq(applications.ats, app.ats), eq(applications.tenant, app.tenant),
          sql`${applications.id} != ${app.id}`, sql`${applications.leaseUntil} is not null`,
        )).limit(1);
        if (busy) continue;
        if (app.state !== 'submission_unknown' && !await discoveryClaimAllowed(tx, app, now)) continue;
        const state = app.state === 'queued' ? 'screening' : app.state === 'submitting' ? 'submission_unknown' : app.state;
        const claimed = one(await tx.update(applications).set({
          state, revision: app.revision + 1, fence: app.fence + 1, leaseUntil: now + LEASE_MS, leaseCheckedAt: now,
          startedAt: app.startedAt ?? now,
        }).where(and(appScope(worker.ownerId, app.id), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
        return { ...clockResponse(now), lease: await leaseOf(tx, claimed) };
      }
      if (candidates.length < 100) break;
      cursor = candidates[candidates.length - 1];
    }
    return { ...clockResponse(now), lease: null };
  });
}
export async function heartbeatWorker(
  db: PrivateDb, token: string, input: HeartbeatRequest, options: WorkerOptions = {},
): Promise<PollResponse> {
  const command = HeartbeatRequestSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    one(await tx.update(workers).set({ lastSeenAt: now }).where(and(
      eq(workers.id, worker.id), eq(workers.ownerId, worker.ownerId), eq(workers.revision, worker.revision),
    )).returning());
    if (!command.lease) return { ...clockResponse(now), lease: null };
    const app = await checkedLease(tx, worker, command.lease, now);
    if (app instanceof WorkerError) return app;
    if (isWaitingState(app.state) || isTerminalState(app.state)) fail(409, 'LEASE_LOST', 'Lease is no longer valid.');
    // Heartbeats do not change logical revision, so a lost response cannot strand a checkpoint.
    const renewed = one(await tx.update(applications).set({ leaseUntil: now + LEASE_MS, leaseCheckedAt: now })
      .where(and(appScope(worker.ownerId, app.id), eq(applications.fence, app.fence), eq(applications.revision, app.revision))).returning());
    return { ...clockResponse(now), lease: await leaseOf(tx, renewed) };
  });
}
