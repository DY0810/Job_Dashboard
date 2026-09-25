import 'server-only';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationArtifacts, applicationEvents, applicationReceipts, applications, documents } from '../private-db/schema.ts';
import { artifactRequestId, type ApplicationArtifactManifest } from './artifact-protocol.ts';
import { hashValue } from './stores.ts';
import { appScope, fail, withWorker, type WorkerOptions } from './worker-store.ts';
import { SubmittedLetterSchema } from './worker-protocol.ts';

/** What each application sent: its tailored resume (with the lines that changed) and its cover letter. */
type Letter = { letter: 'submitted'; introduction: string; body: string[]; conclusion: string; companyParagraph: string };
type Material = { applicationId: string;
  resume: { documentId: string; mime: string; createdAt: number; changes: { before: string; after: string }[] } | null;
  letter: Omit<Letter, 'letter'> | null };

/** Worker call after a verified receipt: keeps the cover letter that went out, once, in the event log. */
export async function recordSubmittedLetter(db: PrivateDb, token: string, applicationId: string, input: unknown, options: WorkerOptions = {}) {
  const letter = SubmittedLetterSchema.parse(input);
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [app] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    const [receipt] = await tx.select({ id: applicationReceipts.intentId }).from(applicationReceipts).where(and(
      eq(applicationReceipts.ownerId, worker.ownerId), eq(applicationReceipts.applicationId, applicationId)));
    if (!app || app.state !== 'submitted' || !receipt) fail(409, 'CONFLICT', 'A cover letter is kept only for a verified submission.');
    const entry: Letter = { letter: 'submitted', introduction: letter.introduction, body: letter.body,
      conclusion: letter.conclusion, companyParagraph: letter.companyParagraph };
    await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId, eventId: artifactRequestId({ letter: applicationId }),
      requestHash: hashValue(entry), acknowledgement: entry, createdAt: now }).onConflictDoNothing();
    return { applicationId, stored: true as const };
  });
}

const Anchors = z.array(z.object({ id: z.string(), text: z.string() })).catch([]);
const Edits = z.array(z.object({ anchorId: z.string(), replacement: z.string() })).catch([]);
function resumeChanges(manifest: ApplicationArtifactManifest) {
  const anchors = Anchors.parse(manifest.template.anchors);
  return Edits.parse(manifest.request.edits).flatMap((edit) => {
    const before = anchors.find((anchor) => anchor.id === edit.anchorId)?.text;
    return before ? [{ before, after: edit.replacement }] : [];
  });
}

export async function listMaterials(db: PrivateDb, ownerId: string) {
  const byApplication = new Map<string, Material>();
  const material = (applicationId: string) => byApplication.get(applicationId) ??
    byApplication.set(applicationId, { applicationId, resume: null, letter: null }).get(applicationId)!;
  const artifacts = await db.select({ applicationId: applicationArtifacts.applicationId, documentId: applicationArtifacts.documentId,
    manifest: applicationArtifacts.manifest, createdAt: applicationArtifacts.createdAt, mime: documents.mime })
    .from(applicationArtifacts).innerJoin(documents, and(eq(documents.ownerId, applicationArtifacts.ownerId),
      eq(documents.id, applicationArtifacts.documentId), eq(documents.state, 'available')))
    .where(eq(applicationArtifacts.ownerId, ownerId)).orderBy(desc(applicationArtifacts.createdAt));
  for (const artifact of artifacts) {
    const item = material(artifact.applicationId);
    item.resume ??= { documentId: artifact.documentId, mime: artifact.mime, createdAt: artifact.createdAt, changes: resumeChanges(artifact.manifest) };
  }
  const letters = await db.select().from(applicationEvents).where(and(eq(applicationEvents.ownerId, ownerId),
    sql`json_extract(${applicationEvents.acknowledgement}, '$.letter') = 'submitted'`));
  for (const row of letters) {
    const { introduction, body, conclusion, companyParagraph } = row.acknowledgement as Letter;
    material(row.applicationId).letter = { introduction, body, conclusion, companyParagraph };
  }
  return { ownerId, materials: [...byApplication.values()] };
}
