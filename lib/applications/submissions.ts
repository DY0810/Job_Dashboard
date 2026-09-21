import 'server-only';
import { and, eq } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationReceipts, applicationSubmissions, applications } from '../private-db/schema.ts';
import { hashValue } from './stores.ts';
import { checkedLease } from './leases.ts';
import { withWorker, appScope, fail, one, type WorkerOptions } from './worker-store.ts';
import {
  ReceiptCommandSchema, SubmissionIntentSchema, type ReceiptCommand, type ReceiptResponse,
  type SubmissionIntent, type SubmissionIntentResponse,
} from './worker-protocol.ts';

function sameIdentity(row: { ats: string; tenant: string; requisition: string }, input: { ats: string; tenant: string; requisition: string }) {
  return row.ats === input.ats && row.tenant === input.tenant && row.requisition === input.requisition;
}

export async function beginSubmission(
  db: PrivateDb, token: string, applicationId: string, input: SubmissionIntent, options: WorkerOptions = {},
): Promise<SubmissionIntentResponse> {
  const command = SubmissionIntentSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [existing] = await tx.select().from(applicationSubmissions).where(and(
      eq(applicationSubmissions.ownerId, worker.ownerId), eq(applicationSubmissions.intentId, command.intentId),
    ));
    if (existing) {
      if (existing.requestHash !== hashValue(command) || existing.applicationId !== applicationId) fail();
      const [app] = await tx.select().from(applications).where(appScope(worker.ownerId, applicationId));
      if (!app || app.state !== 'submitting') fail(409, 'CONFLICT', 'Submission intent is no longer active.');
      return { applicationId, intentId: command.intentId, state: 'submitting', revision: app.revision, fence: app.fence, replayed: true };
    }
    const [app] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    if (!app || app.state !== 'ready') fail(409, 'EXECUTION_DISABLED', 'Application is not ready to submit.');
    const checked = await checkedLease(tx, worker, { applicationId, fence: command.fence, expectedRevision: command.expectedRevision }, now);
    if (checked instanceof Error) throw checked;
    if (!sameIdentity(app, command.identity)) fail(409, 'IDENTITY_MISMATCH', 'Submission identity does not match the claimed role.');
    const [conflict] = await tx.select({ intentId: applicationSubmissions.intentId }).from(applicationSubmissions).where(and(
      eq(applicationSubmissions.ownerId, worker.ownerId), eq(applicationSubmissions.applicationId, applicationId),
    ));
    if (conflict) fail(409, 'SUBMISSION_ALREADY_INTENDED', 'This application already has a submission intent.');
    await tx.insert(applicationSubmissions).values({
      intentId: command.intentId, ownerId: worker.ownerId, applicationId, workerId: worker.id,
      ats: command.identity.ats, tenant: command.identity.tenant, requisition: command.identity.requisition,
      company: command.company, role: command.role, manifestHash: command.manifestHash,
      artifactHashes: command.artifactHashes, requestHash: hashValue(command), createdAt: now,
    });
    const updated = one(await tx.update(applications).set({
      state: 'submitting', revision: app.revision + 1, reasonCode: null,
    }).where(and(appScope(worker.ownerId, applicationId), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
    return { applicationId, intentId: command.intentId, state: 'submitting', revision: updated.revision, fence: updated.fence, replayed: false };
  });
}

export async function recordReceipt(
  db: PrivateDb, token: string, applicationId: string, input: ReceiptCommand, options: WorkerOptions = {},
): Promise<ReceiptResponse> {
  const command = ReceiptCommandSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [intent] = await tx.select().from(applicationSubmissions).where(and(
      eq(applicationSubmissions.ownerId, worker.ownerId), eq(applicationSubmissions.intentId, command.intentId),
      eq(applicationSubmissions.applicationId, applicationId), eq(applicationSubmissions.workerId, worker.id),
    ));
    if (!intent || !sameIdentity(intent, command.identity) || intent.company !== command.company || intent.role !== command.role) {
      fail(409, 'RECEIPT_IDENTITY_MISMATCH', 'Receipt does not match the immutable submission intent.');
    }
    const [previous] = await tx.select().from(applicationReceipts).where(and(
      eq(applicationReceipts.ownerId, worker.ownerId), eq(applicationReceipts.intentId, command.intentId),
    ));
    if (previous) {
      if (previous.receiptId !== command.receiptId || previous.submittedAt !== command.submittedAt) fail();
      const [app] = await tx.select().from(applications).where(appScope(worker.ownerId, applicationId));
      if (!app || app.state !== 'submitted') fail(409, 'CONFLICT', 'Receipt acknowledgement is no longer available.');
      return { applicationId, intentId: command.intentId, state: 'submitted', revision: app.revision, replayed: true };
    }
    if (command.submittedAt > now + 5 * 60_000) fail(400, 'INVALID_RECEIPT', 'Receipt timestamp is in the future.');
    const [app] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    if (!app || !['submitting', 'submission_unknown'].includes(app.state)) fail(409, 'EXECUTION_DISABLED', 'Application is not awaiting a receipt.');
    const checked = await checkedLease(tx, worker, { applicationId, fence: app.fence, expectedRevision: app.revision }, now);
    if (checked instanceof Error) throw checked;
    await tx.insert(applicationReceipts).values({
      intentId: command.intentId, ownerId: worker.ownerId, applicationId,
      ats: command.identity.ats, tenant: command.identity.tenant, requisition: command.identity.requisition,
      company: command.company, role: command.role, receiptId: command.receiptId,
      submittedAt: command.submittedAt, evidence: command.evidence, createdAt: now,
    });
    await tx.update(applicationSubmissions).set({ state: 'submitted', submittedAt: command.submittedAt })
      .where(and(eq(applicationSubmissions.ownerId, worker.ownerId), eq(applicationSubmissions.intentId, command.intentId), eq(applicationSubmissions.state, intent.state)));
    const updated = one(await tx.update(applications).set({
      state: 'submitted', leaseUntil: null, leaseCheckedAt: null, fence: app.fence + 1,
      revision: app.revision + 1, reasonCode: null,
    }).where(and(appScope(worker.ownerId, applicationId), eq(applications.revision, app.revision), eq(applications.fence, app.fence))).returning());
    return { applicationId, intentId: command.intentId, state: 'submitted', revision: updated.revision, replayed: false };
  });
}
