import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationLive, applications } from '../private-db/schema.ts';
import { appScope, fail, withWorker, type WorkerOptions } from './worker-store.ts';
import { LiveFrameSchema } from './worker-protocol.ts';

/** Worker call while it works an application: the newest screenshot and step, and what it filled once it has. */
export async function recordLiveFrame(db: PrivateDb, token: string, applicationId: string, input: unknown, options: WorkerOptions = {}) {
  const frame = LiveFrameSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [app] = await tx.select({ id: applications.id }).from(applications)
      .where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    if (!app) fail(404, 'NOT_FOUND', 'Application not found.');
    const set = { step: frame.step, updatedAt: now,
      ...(frame.image !== undefined ? { image: frame.image } : {}), ...(frame.fields ? { fields: frame.fields } : {}) };
    await tx.insert(applicationLive).values({ ownerId: worker.ownerId, applicationId, image: null, fields: null, ...set })
      .onConflictDoUpdate({ target: [applicationLive.ownerId, applicationLive.applicationId], set });
    return { applicationId, stored: true as const };
  });
}

export async function listLive(db: PrivateDb, ownerId: string) {
  const rows = await db.select().from(applicationLive).where(eq(applicationLive.ownerId, ownerId));
  return { ownerId, live: rows.map(({ applicationId, step, image, fields, updatedAt }) => ({ applicationId, step, image, fields, updatedAt })) };
}
