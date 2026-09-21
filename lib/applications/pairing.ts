import 'server-only';
import { randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { workerPairings, workers } from '../private-db/schema.ts';
import { hashValue } from './stores.ts';
import {
  PairingCreateSchema, PairRequestSchema, RevisionCommandSchema, PAIRING_TTL_MS, HEARTBEAT_MS,
  type PairingCreate, type PairingGrant, type PairRequest, type PairResponse, type RevisionCommand,
  type WorkerList, type Revocation,
} from './worker-protocol.ts';
import {
  workerTransaction, credentialBinding, currentWorker, invalidateWorker, invalidatePairing, nowAt, secretHash, one, fail,
  randomUUID, clockResponse, replayCommand, saveCommand, WorkerError, type WorkerOptions,
} from './worker-store.ts';

export async function createPairing(db: PrivateDb, ownerId: string, input: PairingCreate, options: WorkerOptions = {}): Promise<PairingGrant> {
  const command = PairingCreateSchema.parse(input);
  return workerTransaction(db, async (tx) => {
    const binding = await credentialBinding(tx, ownerId, options);
    if (!binding) fail(403, 'FORBIDDEN', 'Verified applicant credential required.');
    const [previous] = await tx.select().from(workerPairings).where(and(
      eq(workerPairings.ownerId, ownerId), eq(workerPairings.requestId, command.requestId),
    ));
    // Hash-only grants cannot be redisplayed after a lost browser response.
    if (previous) fail(409, 'GRANT_UNAVAILABLE', 'Create a new pairing grant.');
    const grant = randomBytes(32).toString('base64url');
    const pairingId = randomUUID(), expiresAt = nowAt(options) + PAIRING_TTL_MS;
    one(await tx.insert(workerPairings).values({
      id: pairingId, ownerId, grantHash: secretHash(grant), credentialBinding: binding,
      label: command.label, requestId: command.requestId, expiresAt,
    }).returning({ id: workerPairings.id }));
    return { pairingId, ownerId, grant, expiresAt, revision: 1 };
  });
}
export async function pairWorker(db: PrivateDb, input: PairRequest, options: WorkerOptions = {}): Promise<PairResponse> {
  const command = PairRequestSchema.parse(input);
  const result = await workerTransaction(db, async (tx) => {
    const now = nowAt(options), registrationHash = hashValue(command);
    const [pairing] = await tx.select().from(workerPairings).where(eq(workerPairings.grantHash, secretHash(command.grant)));
    if (!pairing || pairing.revokedAt !== null) fail(401, 'WORKER_UNAUTHORIZED', 'Invalid pairing grant.');
    const binding = await credentialBinding(tx, pairing.ownerId, options);
    const [existing] = await tx.select().from(workers).where(eq(workers.pairingId, pairing.id));
    if (!binding || pairing.credentialBinding !== binding) {
      if (existing) await invalidateWorker(tx, existing, now);
      else await invalidatePairing(tx, pairing, now);
      return new WorkerError(401, 'WORKER_UNAUTHORIZED', 'Invalid pairing grant.');
    }
    if (existing) {
      if (existing.id !== command.workerId || existing.registrationId !== command.requestId ||
          existing.registrationHash !== registrationHash) fail();
      if (!await currentWorker(tx, existing, options)) return new WorkerError(401, 'WORKER_UNAUTHORIZED', 'Worker authorization required.');
      return { ...clockResponse(now), workerId: existing.id, ownerId: existing.ownerId, revision: existing.revision };
    }
    if (pairing.consumedAt !== null || pairing.expiresAt <= now) fail(401, 'WORKER_UNAUTHORIZED', 'Invalid pairing grant.');
    const [collision] = await tx.select().from(workers).where(eq(workers.id, command.workerId));
    if (collision) fail();
    one(await tx.update(workerPairings).set({ consumedAt: now, revision: pairing.revision + 1 }).where(and(
      eq(workerPairings.id, pairing.id), eq(workerPairings.ownerId, pairing.ownerId), eq(workerPairings.revision, pairing.revision),
    )).returning());
    const inserted = await tx.insert(workers).values({
      id: command.workerId, ownerId: pairing.ownerId, pairingId: pairing.id, tokenHash: secretHash(command.workerToken),
      credentialBinding: binding, registrationId: command.requestId, registrationHash, label: pairing.label,
      protocolVersion: command.protocolVersion, workerVersion: command.workerVersion, capabilities: command.capabilities,
      createdAt: now, lastSeenAt: now,
    }).onConflictDoNothing().returning();
    one(inserted);
    return { ...clockResponse(now), workerId: command.workerId, ownerId: pairing.ownerId, revision: 1 };
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
export async function listWorkers(db: PrivateDb, ownerId: string, options: WorkerOptions = {}): Promise<WorkerList> {
  return workerTransaction(db, async (tx) => {
    const now = nowAt(options);
    for (const worker of await tx.select().from(workers).where(eq(workers.ownerId, ownerId))) {
      if (worker.revokedAt === null) await currentWorker(tx, worker, options);
    }
    const binding = await credentialBinding(tx, ownerId, options);
    for (const pairing of await tx.select().from(workerPairings).where(and(
      eq(workerPairings.ownerId, ownerId), isNull(workerPairings.consumedAt), isNull(workerPairings.revokedAt),
    ))) {
      if (pairing.credentialBinding !== binding) await invalidatePairing(tx, pairing, now);
    }
    const rows = await tx.select().from(workers).where(eq(workers.ownerId, ownerId)).limit(100);
    const pairings = await tx.select().from(workerPairings).where(eq(workerPairings.ownerId, ownerId)).limit(100);
    return {
      ownerId, serverTime: now,
      workers: rows.map((w) => ({
        id: w.id, label: w.label, revision: w.revision, workerVersion: w.workerVersion, capabilities: w.capabilities,
        createdAt: w.createdAt, lastSeenAt: w.lastSeenAt, revokedAt: w.revokedAt,
        online: w.revokedAt === null && w.lastSeenAt !== null && now >= w.lastSeenAt && now - w.lastSeenAt < HEARTBEAT_MS * 3,
      })),
      pairings: pairings.map(({ id, label, revision, expiresAt, consumedAt, revokedAt }) =>
        ({ id, label, revision, expiresAt, consumedAt, revokedAt })),
    };
  });
}
export async function revokeWorker(db: PrivateDb, ownerId: string, id: string, input: RevisionCommand, options: WorkerOptions = {}): Promise<Revocation> {
  const command = RevisionCommandSchema.parse(input), scope = `worker:${id}`;
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<Revocation>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [row] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, id)));
    if (!row) fail(404, 'NOT_FOUND', 'Worker not found.');
    if (row.revision !== command.expectedRevision) fail();
    const now = nowAt(options);
    await invalidateWorker(tx, row, now);
    const acknowledgement = { id, revision: row.revision + Number(row.revokedAt === null), revokedAt: row.revokedAt ?? now };
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
}
export async function revokePairing(db: PrivateDb, ownerId: string, id: string, input: RevisionCommand, options: WorkerOptions = {}): Promise<Revocation> {
  const command = RevisionCommandSchema.parse(input), scope = `pairing:${id}`;
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<Revocation>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [row] = await tx.select().from(workerPairings).where(and(eq(workerPairings.ownerId, ownerId), eq(workerPairings.id, id)));
    if (!row) fail(404, 'NOT_FOUND', 'Pairing not found.');
    if (row.revision !== command.expectedRevision) fail();
    const now = nowAt(options);
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.pairingId, id)));
    if (worker) await invalidateWorker(tx, worker, now);
    else await invalidatePairing(tx, row, now);
    const acknowledgement = { id, revision: row.revision + Number(row.revokedAt === null), revokedAt: row.revokedAt ?? now };
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
}
