import 'server-only';
import { and, desc, eq, gt, inArray, isNull, or } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationLive, applications } from '../private-db/schema.ts';
import { appScope, fail, nowAt, withWorker, type WorkerOptions } from './worker-store.ts';
import { LiveFrameSchema } from './worker-protocol.ts';
import { ARCHIVE_AFTER_MS, ARCHIVE_KEEP_MS, IN_FLIGHT_STATES, LIVE_STATES } from './buckets.ts';
import { SUBMIT_APPROVAL } from './state.ts';

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

/** `inLive` in SQL: a row being worked, or a form waiting in Live on the applicant's answers or approval. */
export const liveRow = and(isNull(applications.hiddenAt), or(inArray(applications.state, [...LIVE_STATES]),
  eq(applications.reasonCode, 'question_unresolved'), and(eq(applications.state, 'needs_policy_decision'), eq(applications.reasonCode, SUBMIT_APPROVAL))))!;

/**
 * Frames of the rows Live shows (see `inLive`) and listRuns lists, newest first, with each row's current state so the page
 * sees it move. A row that left Live keeps its frame row but is not sent.
 * ponytail: a 3 MB budget keeps the reply under Vercel's 4.5 MB cap; past it the older frames go without their picture.
 */
export async function listLive(db: PrivateDb, ownerId: string, options: WorkerOptions = {}) {
  const rows = await db.select({ applicationId: applicationLive.applicationId, state: applications.state, step: applicationLive.step,
    image: applicationLive.image, fields: applicationLive.fields, updatedAt: applicationLive.updatedAt }).from(applicationLive)
    .innerJoin(applications, and(eq(applications.ownerId, applicationLive.ownerId), eq(applications.id, applicationLive.applicationId)))
    .where(and(eq(applicationLive.ownerId, ownerId), liveRow, or(inArray(applications.state, IN_FLIGHT_STATES),
      gt(applications.createdAt, nowAt(options) - ARCHIVE_AFTER_MS - ARCHIVE_KEEP_MS))))
    .orderBy(desc(applicationLive.updatedAt)).limit(500);
  let budget = 3_000_000;
  const fit = <T>(value: T | null, size: number) => {
    if (value === null || size > budget) return null;
    budget -= size;
    return value;
  };
  // Newest first, so the form being filled keeps its picture; an older form's answers, much smaller, still fit after pictures stop.
  return { ownerId, live: rows.map((row) => {
    const fields = fit(row.fields, JSON.stringify(row.fields).length);
    return { ...row, fields, image: fit(row.image, row.image?.length ?? 0) };
  }) };
}
