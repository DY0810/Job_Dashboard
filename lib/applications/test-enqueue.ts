import { and, desc, eq } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationRuns, applications } from '../private-db/schema.ts';
import { applicationSummary } from './runs.ts';
import { ApplicationIdentitySchema, type ApplicationIdentity, type ApplicationSummary } from './worker-protocol.ts';
import { fail, nowAt, one, randomUUID, workerTransaction, type WorkerOptions } from './worker-store.ts';

/** Test helper: discovery owns real enqueueing; there is no public enqueue route. */
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
