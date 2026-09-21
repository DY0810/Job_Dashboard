import 'server-only';
import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import { getAuth } from '../auth.ts';
import { lookupApplicant, privateJson, privateResponse } from '../applicant-access.ts';
import { getPrivateDb } from '../private-db/index.ts';
import { getDiscoveryCorpus } from './discovery-corpus.ts';
import { rateLimit } from '../private-db/schema.ts';
import { assertExpectedApplicant, ApplicantPreconditionError } from './applicant-precondition.ts';
import { readPrivateJson, PrivateInputError } from './private-http.ts';
import { WorkerError, withWorker, type WorkerOptions } from './worker-store.ts';
import * as p from './worker-protocol.ts';
import { createPairing, pairWorker, listWorkers, revokeWorker, revokePairing } from './pairing.ts';
import { createRun, listRuns, commandRun, commandApplication } from './runs.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent, submitIntent } from './events.ts';
import { beginSubmission, recordReceipt } from './submissions.ts';
import { applicationContext, applicationDocumentOwner } from './application-context.ts';
import { createArtifactIntent, uploadArtifact } from './artifacts.ts';
import { documentStorageConfig, readDocumentObject } from './documents-storage.ts';
import { getPolicy, getProfile } from './stores.ts';
import { ApplicationContextSchema, ApplicationContextRequestSchema } from './application-context-protocol.ts';
import { ProviderConfigRequestSchema, ProviderConfigSchema } from './provider-protocol.ts';
import { ArtifactIntentSchema, ArtifactIntentResponseSchema, ArtifactUploadResponseSchema } from './artifact-protocol.ts';

async function limit(key: string, max: number) {
  const window = Math.floor(Date.now() / 60_000) * 60_000;
  const [row] = await getPrivateDb().insert(rateLimit).values({
    id: crypto.randomUUID(), key, count: 1, lastRequest: window,
  }).onConflictDoUpdate({
    target: rateLimit.key,
    set: {
      count: sql`case when ${rateLimit.lastRequest} < ${window} then 1 else ${rateLimit.count} + 1 end`,
      lastRequest: sql`case when ${rateLimit.lastRequest} < ${window} then ${window} else ${rateLimit.lastRequest} end`,
    },
  }).returning({ count: rateLimit.count });
  if (row.count > max) throw new WorkerError(429, 'RATE_LIMITED', 'Too many requests. Retry next minute.');
}
export { limit as limitWorkerRequests };
function errorResponse(error: unknown, headers?: HeadersInit) {
  let status = 503, code = 'UNAVAILABLE', message = 'Private worker storage unavailable.';
  if (error instanceof WorkerError) { status = error.status; code = error.code; message = error.message; }
  else if (error instanceof ApplicantPreconditionError) { status = 403; code = 'PRINCIPAL_CHANGED'; message = error.message; }
  else if (error instanceof PrivateInputError) { status = error.status; code = 'INVALID_INPUT'; message = error.message; }
  else if (error instanceof z.ZodError) { status = 400; code = 'INVALID_INPUT'; message = 'Invalid request fields.'; }
  const responseHeaders = new Headers(headers);
  if (status === 429) responseHeaders.set('Retry-After', '60');
  return privateJson({ error: message, code }, { status, headers: responseHeaders });
}
function checkPath(request: Request, ids: string[]) {
  if (new URL(request.url).search || ids.some((id) => !z.uuid().safeParse(id).success)) {
    throw new WorkerError(400, 'INVALID_INPUT', 'Invalid request path.');
  }
}
type BrowserAction = 'list-workers' | 'create-pairing' | 'revoke-pairing' | 'revoke-worker' |
  'list-runs' | 'create-run' | 'command-run' | 'command-application';

const confirmed = <T>(fact: { state: string; value: T | null }) => fact.state === 'confirmed' ? fact.value : null;
async function providerConfig(db: Parameters<typeof getProfile>[0], ownerId: string) {
  const [profileResponse, policy] = await Promise.all([getProfile(db, ownerId), getPolicy(db, ownerId)]);
  const profile = profileResponse.profile.documentsProvider;
  const currentPolicy = policy.policy;
  const selected = confirmed(profile.provider) === 'typesafe_jev';
  const budget = confirmed(profile.requestBudget);
  const maxUsd = selected && budget?.currency === 'USD' ? Math.min(10, budget.amount) : 0;
  const enabled = selected && maxUsd > 0 && policy.enabled && currentPolicy.privacy === 'approved_remote' &&
    currentPolicy.remoteProviderConsent && currentPolicy.allowedProviders.includes('typesafe:jev') && currentPolicy.fallbackOrder.length === 0;
  return ProviderConfigSchema.parse({
    providerProtocolVersion: 1, ownerId, profileRevision: profileResponse.revision,
    policyRevision: policy.revision, policyVersion: policy.policyVersion, policyHash: policy.policyHash,
    enabled, provider: selected ? 'typesafe_jev' : 'none',
    model: selected ? (confirmed(profile.model) ?? 'jev-latest') : null,
    endpoint: selected ? confirmed(profile.endpoint) : null,
    privacy: currentPolicy.privacy, remoteProviderConsent: currentPolicy.remoteProviderConsent,
    allowedProviders: currentPolicy.allowedProviders, fallbackOrder: currentPolicy.fallbackOrder, maxUsd,
  });
}

export async function browserWorkerEndpoint(request: Request, action: BrowserAction, ...ids: string[]) {
  let headers: Headers | undefined;
  try {
    checkPath(request, ids);
    const result = await lookupApplicant(request);
    if (result instanceof Response) {
      const body = await result.json().catch(() => ({}));
      return privateJson({ error: body.error ?? 'Applicant authorization required.',
        code: result.status === 401 ? 'AUTH_REQUIRED' : result.status === 403 ? 'FORBIDDEN' :
          result.status === 429 ? 'RATE_LIMITED' : 'UNAVAILABLE' },
      { status: result.status, headers: result.headers });
    }
    headers = result.response.headers;
    const ownerId = result.applicant.ownerId;
    assertExpectedApplicant(request, ownerId);
    await limit(`private-worker-browser:${ownerId}`, 60);
    const db = getPrivateDb(), options: WorkerOptions = { isAllowedApplicant: getAuth().isAllowedApplicant };
    let body: unknown;
    switch (action) {
      case 'list-workers': body = p.WorkerListSchema.parse(await listWorkers(db, ownerId, options)); break;
      case 'create-pairing': body = p.PairingGrantSchema.parse(await createPairing(db, ownerId, await readPrivateJson(request, p.PairingCreateSchema), options)); break;
      case 'revoke-worker': body = p.RevocationSchema.parse(await revokeWorker(db, ownerId, ids[0], await readPrivateJson(request, p.RevisionCommandSchema), options)); break;
      case 'revoke-pairing': body = p.RevocationSchema.parse(await revokePairing(db, ownerId, ids[0], await readPrivateJson(request, p.RevisionCommandSchema), options)); break;
      case 'list-runs': body = p.RunListSchema.parse(await listRuns(db, ownerId)); break;
      case 'create-run': body = p.RunSchema.parse(await createRun(db, ownerId, await readPrivateJson(request, p.RunCreateSchema), options)); break;
      case 'command-run': body = p.RunSchema.parse(await commandRun(db, ownerId, ids[0], await readPrivateJson(request, p.RunCommandSchema), options)); break;
      case 'command-application': body = p.ApplicationSummarySchema.parse(await commandApplication(db, ownerId, ids[0], ids[1], await readPrivateJson(request, p.ApplicationCommandSchema), options)); break;
    }
    return privateJson(body, { headers });
  } catch (error) { return errorResponse(error, headers); }
}
export async function workerEndpoint(request: Request, action: 'pair' | 'poll' | 'heartbeat' | 'event' | 'submit-intent' | 'submission-intent' | 'receipt' | 'provider-config' | 'context' | 'artifact-intent', id?: string) {
  try {
    checkPath(request, id ? [id] : []);
    const db = getPrivateDb(), options: WorkerOptions = { isAllowedApplicant: getAuth().isAllowedApplicant };
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
    let workerOwnerId: string | undefined;
    if (action === 'pair') await limit('private-worker-pair', 30);
    else {
      // Authentication runs before allocating a bucket, so arbitrary tokens cannot grow it.
      const worker = await withWorker(db, token, options, async (_tx, row) => ({ id: row.id, ownerId: row.ownerId }));
      workerOwnerId = worker.ownerId;
      await limit(`private-worker:${worker.id}`, 120);
    }
    const raw = await readPrivateJson(request, z.unknown());
    if (!raw || typeof raw !== 'object' || !('protocolVersion' in raw) || raw.protocolVersion !== p.WORKER_PROTOCOL_VERSION ||
        ('capabilities' in raw && JSON.stringify(raw.capabilities) !== JSON.stringify(p.WORKER_CAPABILITIES))) {
      throw new WorkerError(426, 'PROTOCOL_MISMATCH', 'Worker protocol or capabilities are not supported.');
    }
    let body: unknown;
    switch (action) {
      case 'pair': body = p.PairResponseSchema.parse(await pairWorker(db, p.PairRequestSchema.parse(raw), options)); break;
      case 'poll': body = p.PollResponseSchema.parse(await pollWorker(db, token, p.PollRequestSchema.parse(raw), { ...options, corpus: getDiscoveryCorpus })); break;
      case 'heartbeat': body = p.PollResponseSchema.parse(await heartbeatWorker(db, token, p.HeartbeatRequestSchema.parse(raw), options)); break;
      case 'event': body = p.EventResponseSchema.parse(await recordWorkerEvent(db, token, id!, p.EventRequestSchema.parse(raw), options)); break;
      case 'submit-intent': body = await submitIntent(db, token, id!, p.SubmitIntentSchema.parse(raw), options); break;
      case 'submission-intent': body = p.SubmissionIntentResponseSchema.parse(await beginSubmission(db, token, id!, p.SubmissionIntentSchema.parse(raw), options)); break;
      case 'receipt': body = p.ReceiptResponseSchema.parse(await recordReceipt(db, token, id!, p.ReceiptCommandSchema.parse(raw), options)); break;
      case 'context': body = ApplicationContextSchema.parse(await applicationContext(db, token, id!, ApplicationContextRequestSchema.parse(raw), options)); break;
      case 'artifact-intent': body = ArtifactIntentResponseSchema.parse(await createArtifactIntent(db, token, id!, ArtifactIntentSchema.parse(raw), options)); break;
      case 'provider-config': {
        ProviderConfigRequestSchema.parse(raw);
        body = await providerConfig(db, workerOwnerId!);
        body = ProviderConfigSchema.parse(body);
        break;
      }
    }
    return privateJson(body);
  } catch (error) { return errorResponse(error); }
}

export async function workerArtifactUploadEndpoint(request: Request, applicationId: string, artifactId: string) {
  try {
    checkPath(request, [applicationId, artifactId]);
    const db = getPrivateDb(), options: WorkerOptions = { isAllowedApplicant: getAuth().isAllowedApplicant };
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
    const worker = await withWorker(db, token, options, async (_tx, row) => ({ id: row.id }));
    await limit(`private-worker:${worker.id}`, 120);
    return privateJson(ArtifactUploadResponseSchema.parse(await uploadArtifact(db, token, applicationId, artifactId, request, options)));
  } catch (error) { return errorResponse(error); }
}

export async function workerDocumentEndpoint(request: Request, applicationId: string, documentId: string) {
  try {
    if (request.method !== 'GET' || new URL(request.url).search) throw new WorkerError(400, 'INVALID_INPUT', 'Invalid document request.');
    const token = request.headers.get('authorization')?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1] ?? '';
    const db = getPrivateDb(), options: WorkerOptions = { isAllowedApplicant: getAuth().isAllowedApplicant };
    const worker = await withWorker(db, token, options, async (_tx, row) => ({ id: row.id }));
    await limit(`private-worker:${worker.id}`, 120);
    const document = await applicationDocumentOwner(db, token, applicationId, documentId, options);
    const bytes = await readDocumentObject(documentStorageConfig(), document.objectKey);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== document.sha256 || bytes.length !== document.size) throw new WorkerError(503, 'DOCUMENT_CHANGED', 'Document bytes are unavailable.');
    const headers = new Headers({ 'Content-Type': document.mime, 'Content-Length': String(bytes.length) });
    return privateResponse(new Response(Buffer.from(bytes), { headers }));
  } catch (error) { return errorResponse(error); }
}
