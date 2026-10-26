import 'server-only';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationLive, applications } from '../private-db/schema.ts';
import { appScope, fail, withWorker, type WorkerOptions } from './worker-store.ts';
import { LiveFrameSchema, VerificationCodeSchema, VerificationCodeTakeSchema } from './worker-protocol.ts';
import { LIVE_STATES } from './buckets.ts';
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

/** Applicant call: the security code an employer emailed for a form being submitted. The worker types it in on its next check. */
export async function setVerificationCode(db: PrivateDb, ownerId: string, applicationId: string, input: unknown) {
  const { code } = VerificationCodeSchema.parse(input);
  const [app] = await db.select({ id: applications.id }).from(applications)
    .where(and(appScope(ownerId, applicationId), eq(applications.state, 'submitting')));
  if (!app) fail(409, 'CONFLICT', 'This application is not being submitted.');
  await db.insert(applicationLive).values({ ownerId, applicationId, step: 'Submitting the application', verificationCode: code, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: [applicationLive.ownerId, applicationLive.applicationId], set: { verificationCode: code } });
  return { applicationId, stored: true as const };
}

/** Worker call while the employer's form waits on a code: takes it once, so a mistyped code can be entered again. */
export async function takeVerificationCode(db: PrivateDb, token: string, applicationId: string, input: unknown, options: WorkerOptions = {}) {
  VerificationCodeTakeSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker) => {
    const [app] = await tx.select({ id: applications.id }).from(applications).where(and(appScope(worker.ownerId, applicationId),
      eq(applications.workerId, worker.id), eq(applications.state, 'submitting')));
    if (!app) fail(404, 'NOT_FOUND', 'Application not found.');
    const row = and(eq(applicationLive.ownerId, worker.ownerId), eq(applicationLive.applicationId, applicationId));
    const [live] = await tx.select({ code: applicationLive.verificationCode }).from(applicationLive).where(row);
    if (live?.code) await tx.update(applicationLive).set({ verificationCode: null }).where(row);
    return { code: live?.code ?? null };
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
export async function listLive(db: PrivateDb, ownerId: string) {
  const rows = await db.select({ applicationId: applicationLive.applicationId, state: applications.state, step: applicationLive.step,
    image: applicationLive.image, fields: applicationLive.fields, updatedAt: applicationLive.updatedAt }).from(applicationLive)
    .innerJoin(applications, and(eq(applications.ownerId, applicationLive.ownerId), eq(applications.id, applicationLive.applicationId)))
    .where(and(eq(applicationLive.ownerId, ownerId), liveRow))
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
