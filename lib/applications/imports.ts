import 'server-only';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ReadDb } from '../db/index.ts';
import type { PrivateDb } from '../private-db/index.ts';
import { applications, discoveryTargets, legacyImportPreviews, manualApplicationMarks } from '../private-db/schema.ts';
import { captureLegacyPostings } from './discovery-source.ts';
import { resolveApplicationIdentity } from './application-identity.ts';
import { hashValue } from './stores.ts';
import {
  ImportPreviewRequestSchema, ImportPreviewSchema, ImportConfirmRequestSchema, ImportAcknowledgementSchema,
  IMPORT_PREVIEW_TTL_MS, type ImportPreviewRequest, type ImportPreview, type ImportPreviewRow,
  type ImportConfirmRequest, type ImportAcknowledgement,
} from './discovery-protocol.ts';
import { fail, nowAt, one, randomUUID, releaseApplication, replayCommand, saveCommand, workerTransaction, type WorkerOptions } from './worker-store.ts';
import { isTerminalState } from './state.ts';

/** Caller supplies the authenticated owner and corpus handle; no environment-selected test database. */
export async function previewLegacyImport(
  db: PrivateDb, ownerId: string, corpus: () => ReadDb | Promise<ReadDb>, input: ImportPreviewRequest, options: WorkerOptions = {},
): Promise<ImportPreview> {
  const command = ImportPreviewRequestSchema.parse(input), requestHash = hashValue(command);
  const previous = await db.select().from(legacyImportPreviews).where(and(
    eq(legacyImportPreviews.ownerId, ownerId), eq(legacyImportPreviews.requestId, command.requestId),
  ));
  if (previous.length) {
    if (previous[0].requestHash !== requestHash) fail();
    return ImportPreviewSchema.parse(previous[0].preview);
  }
  const postings = await captureLegacyPostings(await corpus(), command.postingIds);
  const byId = new Map(postings.map((posting) => [posting.postingId, posting]));
  const rows: ImportPreviewRow[] = command.postingIds.map((postingId) => {
    const posting = byId.get(postingId);
    if (!posting) return { postingId, company: null, title: null, url: null, identity: null,
      resolution: 'unresolved', reason: 'posting_missing' };
    const resolved = resolveApplicationIdentity(posting.canonicalUrl, posting.sources);
    return {
      postingId, company: posting.company, title: posting.title, url: resolved.officialUrl ?? posting.canonicalUrl,
      identity: resolved.status === 'resolved' ? resolved.identity : null,
      resolution: resolved.status === 'resolved' ? 'resolved' : 'unresolved',
      reason: resolved.status === 'resolved' ? null : resolved.reasons.join(','),
    };
  });
  const now = nowAt(options), id = randomUUID(), expiresAt = now + IMPORT_PREVIEW_TTL_MS;
  const preview = ImportPreviewSchema.parse({
    ownerId, previewToken: id, previewHash: hashValue({ ownerId, id, expiresAt, rows }), expiresAt, rows,
  });
  return workerTransaction(db, async (tx) => {
    await tx.insert(legacyImportPreviews).values({
      id, ownerId, requestId: command.requestId, requestHash, preview, createdAt: now, expiresAt,
    }).onConflictDoNothing({ target: [legacyImportPreviews.ownerId, legacyImportPreviews.requestId] });
    const row = one(await tx.select().from(legacyImportPreviews).where(and(
      eq(legacyImportPreviews.ownerId, ownerId), eq(legacyImportPreviews.requestId, command.requestId),
    )));
    if (row.requestHash !== requestHash) fail();
    return ImportPreviewSchema.parse(row.preview);
  });
}

export async function confirmLegacyImport(
  db: PrivateDb, ownerId: string, input: ImportConfirmRequest, options: WorkerOptions = {},
): Promise<ImportAcknowledgement> {
  const command = ImportConfirmRequestSchema.parse(input);
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ImportAcknowledgement>(tx, ownerId, 'import:confirm', command);
    if (replay) return ImportAcknowledgementSchema.parse(replay);
    const [record] = await tx.select().from(legacyImportPreviews).where(and(
      eq(legacyImportPreviews.ownerId, ownerId), eq(legacyImportPreviews.id, command.previewToken),
    ));
    if (!record) fail(404, 'NOT_FOUND', 'Import preview not found.');
    const preview = ImportPreviewSchema.parse(record.preview), now = nowAt(options);
    if (record.expiresAt <= now) fail(409, 'PREVIEW_EXPIRED', 'Import preview expired. Preview again.');
    if (record.requestId === command.requestId || preview.previewHash !== command.previewHash ||
        preview.previewHash !== hashValue({ ownerId, id: record.id, expiresAt: record.expiresAt, rows: preview.rows })) fail();
    const byId = new Map(preview.rows.map((row) => [row.postingId, row]));
    if (command.postingIds.some((id) => !byId.has(id))) fail(400, 'INVALID_INPUT', 'Selection is outside the preview.');
    const selected = command.postingIds.map((id) => byId.get(id)!);
    await tx.insert(manualApplicationMarks).values(selected.map((row) => ({
      id: randomUUID(), ownerId, previewId: record.id, postingId: row.postingId, evidence: row,
      ats: row.identity?.ats ?? null, tenant: row.identity?.tenant ?? null, requisition: row.identity?.requisition ?? null,
      createdAt: now,
    }))).onConflictDoNothing({ target: [manualApplicationMarks.ownerId, manualApplicationMarks.previewId, manualApplicationMarks.postingId] });
    const persisted = await tx.select({ id: manualApplicationMarks.postingId }).from(manualApplicationMarks).where(and(
      eq(manualApplicationMarks.ownerId, ownerId), eq(manualApplicationMarks.previewId, record.id),
      inArray(manualApplicationMarks.postingId, command.postingIds),
    ));
    if (persisted.length !== selected.length) fail();
    const suppress = sql`exists (select 1 from ${manualApplicationMarks} m where m.owner_id = ${applications.ownerId}
      and m.ats = ${applications.ats} and m.tenant = ${applications.tenant} and m.requisition = ${applications.requisition})`;
    for (const app of await tx.select().from(applications).where(and(eq(applications.ownerId, ownerId), suppress))) {
      if (isTerminalState(app.state) || app.state === 'submission_unknown') continue;
      const released = await releaseApplication(tx, app, 'manual_reported');
      if (released.state !== 'submission_unknown') {
        one(await tx.update(applications).set({ state: 'skipped' }).where(and(
          eq(applications.ownerId, ownerId), eq(applications.id, app.id), eq(applications.revision, released.revision),
        )).returning());
      }
    }
    await tx.update(discoveryTargets).set({ disposition: 'manual_reported' }).where(and(
      eq(discoveryTargets.ownerId, ownerId), sql`exists (select 1 from ${manualApplicationMarks} m
        where m.owner_id = ${discoveryTargets.ownerId} and m.ats = ${discoveryTargets.ats}
        and m.tenant = ${discoveryTargets.tenant} and m.requisition = ${discoveryTargets.requisition})`,
    ));
    const resolvedCount = selected.filter((row) => row.resolution === 'resolved').length;
    const acknowledgement = ImportAcknowledgementSchema.parse({
      ownerId, previewToken: record.id, requestId: command.requestId, status: 'manual_reported',
      importedPostingIds: command.postingIds, resolvedCount, unresolvedCount: selected.length - resolvedCount,
    });
    await saveCommand(tx, ownerId, 'import:confirm', command, acknowledgement, now);
    return acknowledgement;
  });
}
