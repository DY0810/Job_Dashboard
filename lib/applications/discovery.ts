import 'server-only';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { ReadDb } from '../db/index.ts';
import type { PrivateDb } from '../private-db/index.ts';
import {
  applicationEvents, applicationRuns, applications, discoveryManifests, discoveryTargets, manualApplicationMarks, workers, workerCommands,
} from '../private-db/schema.ts';
import { captureCandidateSnapshot, type DiscoveryCandidate } from './discovery-source.ts';
import { getPolicy, hashValue } from './stores.ts';
import { isTerminalState } from './state.ts';
import type { Policy } from './policy.ts';
import { applicationSummary, releaseRunApplications } from './runs.ts';
import {
  AbandonDiscoverySchema, AbandonDiscoveryResponseSchema, DiscoveryStatusSchema, ReapplyRequestSchema,
  type DiscoveryStatus, type ReapplyRequest, type TargetDisposition,
} from './discovery-protocol.ts';
import {
  currentWorker, fail, nowAt, one, randomUUID, replayCommand, saveCommand, withWorker, workerTransaction,
  WorkerError, type ApplicationRow, type WorkerOptions, type WorkerTx,
} from './worker-store.ts';

export const DISCOVERY_INTERVAL_MS = 60_000;
export const STAGING_CHUNK_SIZE = 200;
const CAPTURE_LEASE_MS = 120_000;
const DAY_MS = 86_400_000;
type RunRow = typeof applicationRuns.$inferSelect;
export type CorpusProvider = () => ReadDb | Promise<ReadDb>;
const runScope = (ownerId: string, id: string) => and(eq(applicationRuns.ownerId, ownerId), eq(applicationRuns.id, id));
const manifestScope = (ownerId: string, id: string) => and(eq(discoveryManifests.ownerId, ownerId), eq(discoveryManifests.id, id));
const identityMatch = (app: Pick<ApplicationRow, 'ownerId' | 'ats' | 'tenant' | 'requisition'>) => and(
  eq(applications.ownerId, app.ownerId), eq(applications.ats, app.ats),
  eq(applications.tenant, app.tenant), eq(applications.requisition, app.requisition),
);
export async function currentDiscoveryPolicy(tx: WorkerTx, run: RunRow, now: number) {
  const policy = await getPolicy(tx, run.ownerId, now);
  if (run.state !== 'running' || !policy.enabled || policy.revision !== run.policyRevision ||
      policy.policyVersion !== run.policyVersion || policy.policyHash !== run.policyHash ||
      !policy.policy.actions.includes('read_jobs')) return null;
  return policy.policy;
}
export async function manuallySuppressed(tx: WorkerTx, app: Pick<ApplicationRow, 'ownerId' | 'ats' | 'tenant' | 'requisition'>) {
  const [mark] = await tx.select({ id: manualApplicationMarks.id }).from(manualApplicationMarks).where(and(
    eq(manualApplicationMarks.ownerId, app.ownerId), eq(manualApplicationMarks.ats, app.ats),
    eq(manualApplicationMarks.tenant, app.tenant), eq(manualApplicationMarks.requisition, app.requisition),
  )).limit(1);
  return !!mark;
}
const initialDisposition = (candidate: DiscoveryCandidate): TargetDisposition =>
  !candidate.identity || candidate.identityStatus !== 'resolved' ? 'unresolved' :
    candidate.disposition !== 'candidate' ? 'held_policy' : 'eligible';

/** Outbound worker polling is the scheduler. Corpus access occurs only after worker authorization. */
export async function discoverWorkerRuns(db: PrivateDb, token: string, corpus: CorpusProvider, options: WorkerOptions = {}) {
  const selected = await withWorker(db, token, options, async (tx, worker, now) => {
    const [run] = await tx.select().from(applicationRuns).where(and(
      eq(applicationRuns.ownerId, worker.ownerId), eq(applicationRuns.workerId, worker.id), eq(applicationRuns.state, 'running'),
      sql`coalesce(${applicationRuns.captureUntil}, 0) <= ${now} and
        (${applicationRuns.discoveryState} = 'staging' or coalesce(${applicationRuns.lastScanAt}, 0) <= ${now - DISCOVERY_INTERVAL_MS})`,
    )).orderBy(asc(sql`coalesce(${applicationRuns.lastAttemptAt}, 0)`), asc(applicationRuns.id)).limit(1);
    if (!run) return null;
    if (!await currentDiscoveryPolicy(tx, run, now)) {
      one(await tx.update(applicationRuns).set({ discoveryError: 'POLICY_STALE', captureUntil: now + DISCOVERY_INTERVAL_MS })
        .where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision))).returning());
      return null;
    }
    if (run.discoveryState === 'staging' && run.currentManifestId) return { run, manifestId: run.currentManifestId, captureToken: null };
    const captureToken = randomUUID();
    one(await tx.update(applicationRuns).set({
      discoveryState: 'capturing', captureToken, captureUntil: now + CAPTURE_LEASE_MS, lastAttemptAt: now, discoveryError: null,
    }).where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision),
      sql`${applicationRuns.captureToken} is ${run.captureToken}`)).returning());
    return { run, manifestId: null, captureToken };
  });
  if (!selected) return;
  let manifestId = selected.manifestId;
  if (!manifestId) {
    try {
      // Recheck credentials/policy before even resolving the injected corpus handle.
      const policy = await withWorker(db, token, options, async (tx, worker, now) => {
        const [run] = await tx.select().from(applicationRuns).where(and(runScope(worker.ownerId, selected.run.id),
          eq(applicationRuns.captureToken, selected.captureToken!)));
        const active = run && await currentDiscoveryPolicy(tx, run, now);
        if (!active) fail(409, 'POLICY_STALE', 'Discovery policy changed.');
        return active;
      });
      const snapshot = await captureCandidateSnapshot(await corpus(), policy, nowAt(options));
      const hash = hashValue(snapshot);
      manifestId = await withWorker(db, token, options, async (tx, worker, now) => {
        const [run] = await tx.select().from(applicationRuns).where(and(runScope(worker.ownerId, selected.run.id),
          eq(applicationRuns.captureToken, selected.captureToken!)));
        if (!run || !await currentDiscoveryPolicy(tx, run, now) || run.captureUntil! <= now) {
          fail(409, 'CAPTURE_STALE', 'Discovery capture no longer owns the run.');
        }
        const id = randomUUID();
        one(await tx.insert(discoveryManifests).values({
          id, ownerId: run.ownerId, runId: run.id, policyRevision: run.policyRevision,
          artifact: snapshot, hash, capturedAt: snapshot.capturedAt, candidateCount: snapshot.candidates.length,
        }).returning({ id: discoveryManifests.id }));
        one(await tx.update(applicationRuns).set({
          discoveryState: 'staging', currentManifestId: id, captureToken: null, captureUntil: null,
        }).where(and(runScope(run.ownerId, run.id), eq(applicationRuns.captureToken, selected.captureToken!),
          eq(applicationRuns.revision, run.revision))).returning());
        return id;
      });
    } catch (error) {
      await workerTransaction(db, async (tx) => {
        await tx.update(applicationRuns).set({
          discoveryState: 'failed', captureToken: null, captureUntil: nowAt(options) + DISCOVERY_INTERVAL_MS,
          discoveryError: error instanceof WorkerError ? error.code : 'CAPTURE_FAILED',
        }).where(and(runScope(selected.run.ownerId, selected.run.id), eq(applicationRuns.captureToken, selected.captureToken!)));
      });
      return;
    }
  }
  try {
    await stageDiscoveryManifest(db, token, manifestId, options);
  } catch (error) {
    if (error instanceof WorkerError && error.status === 401) throw error;
    // The failed chunk rolled back; keep its manifest/cursor available for the next poll.
    await workerTransaction(db, async (tx) => {
      await tx.update(applicationRuns).set({ discoveryError: error instanceof WorkerError ? error.code : 'STAGING_FAILED' })
        .where(and(runScope(selected.run.ownerId, selected.run.id), eq(applicationRuns.currentManifestId, manifestId),
          eq(applicationRuns.state, 'running'), eq(applicationRuns.discoveryState, 'staging')));
    });
  }
}

/** Each committed chunk is resumable. Only the final transaction makes any member claimable. */
export async function stageDiscoveryManifest(db: PrivateDb, token: string, id: string, options: WorkerOptions = {}) {
  return withWorker(db, token, options, async (tx, worker, now) => {
    const [manifest] = await tx.select().from(discoveryManifests).where(manifestScope(worker.ownerId, id));
    if (!manifest) fail(404, 'NOT_FOUND', 'Discovery manifest not found.');
    const [run] = await tx.select().from(applicationRuns).where(and(runScope(worker.ownerId, manifest.runId),
      eq(applicationRuns.workerId, worker.id)));
    if (!run) fail(404, 'NOT_FOUND', 'Discovery run not found.');
    if (manifest.state !== 'staging') return;
    if (!await currentDiscoveryPolicy(tx, run, now)) {
      one(await tx.update(applicationRuns).set({ discoveryError: 'POLICY_STALE' })
        .where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision))).returning());
      return;
    }
    if (run.currentManifestId !== id || hashValue(manifest.artifact) !== manifest.hash ||
        manifest.artifact.candidates.length !== manifest.candidateCount) {
      fail(409, 'MANIFEST_CORRUPT', 'Discovery manifest failed integrity validation.');
    }
    const chunk = manifest.artifact.candidates.slice(manifest.stagedCount, manifest.stagedCount + STAGING_CHUNK_SIZE);
    if (chunk.length) {
      await tx.insert(discoveryTargets).values(chunk.map((candidate, index) => ({
        id: randomUUID(), ownerId: worker.ownerId, runId: run.id, manifestId: id, targetKey: candidate.targetKey,
        candidateIndex: manifest.stagedCount + index, candidateHash: hashValue(candidate),
        ats: candidate.identity?.ats ?? null, tenant: candidate.identity?.tenant ?? null,
        requisition: candidate.identity?.requisition ?? null,
        // Employer labels group caps only; they are never application identity.
        employerKey: candidate.postings[0]?.company.trim().toLowerCase().replace(/\s+/g, ' ') || null,
        disposition: initialDisposition(candidate),
      }))).onConflictDoUpdate({
        target: [discoveryTargets.ownerId, discoveryTargets.runId, discoveryTargets.targetKey],
        set: {
          manifestId: sql`excluded.manifest_id`, candidateIndex: sql`excluded.candidate_index`,
          candidateHash: sql`excluded.candidate_hash`, ats: sql`excluded.ats`, tenant: sql`excluded.tenant`,
          requisition: sql`excluded.requisition`, employerKey: sql`excluded.employer_key`, disposition: sql`excluded.disposition`,
        },
        setWhere: sql`${discoveryTargets.applicationId} is null and ${discoveryTargets.disposition} != 'manual_reported'`,
      });
      const persisted = await tx.select({ key: discoveryTargets.targetKey }).from(discoveryTargets).where(and(
        eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.runId, run.id),
        inArray(discoveryTargets.targetKey, chunk.map((candidate) => candidate.targetKey)),
      ));
      if (persisted.length !== chunk.length) fail(409, 'STAGING_INCOMPLETE', 'Target staging did not persist.');
    }
    const stagedCount = manifest.stagedCount + chunk.length;
    one(await tx.update(discoveryManifests).set({ stagedCount, revision: manifest.revision + 1 })
      .where(and(manifestScope(worker.ownerId, id), eq(discoveryManifests.revision, manifest.revision),
        eq(discoveryManifests.state, 'staging'))).returning());
    if (stagedCount !== manifest.candidateCount) return;
    await tx.update(discoveryTargets).set({ disposition: 'manual_reported' }).where(and(
      eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.manifestId, id),
      sql`exists (select 1 from ${manualApplicationMarks} m where m.owner_id = ${discoveryTargets.ownerId}
        and m.ats = ${discoveryTargets.ats} and m.tenant = ${discoveryTargets.tenant} and m.requisition = ${discoveryTargets.requisition})`,
    ));
    // One INSERT SELECT is bounded by the captured manifest, not a changing corpus or UI page.
    await tx.run(sql`insert into ${applications}
      (id, owner_id, run_id, worker_id, ats, tenant, requisition, available_at, created_at,
       snapshot_manifest_id, snapshot_target_key, snapshot_hash, employer_key)
      select t.id, t.owner_id, t.run_id, ${worker.id}, t.ats, t.tenant, t.requisition, ${now}, ${now},
        t.manifest_id, t.target_key, t.candidate_hash, t.employer_key
      from ${discoveryTargets} t where t.owner_id = ${worker.ownerId} and t.manifest_id = ${id}
        and t.disposition = 'eligible'
        and not exists (select 1 from ${applications} a where a.owner_id = t.owner_id
          and a.ats = t.ats and a.tenant = t.tenant and a.requisition = t.requisition)
      on conflict (owner_id, ats, tenant, requisition, attempt) do nothing`);
    const appId = sql<string>`(select a.id from ${applications} a where a.owner_id = ${discoveryTargets.ownerId}
      and a.ats = ${discoveryTargets.ats} and a.tenant = ${discoveryTargets.tenant}
      and a.requisition = ${discoveryTargets.requisition} order by a.attempt desc limit 1)`;
    await tx.update(discoveryTargets).set({
      applicationId: appId, disposition: sql`case when exists (select 1 from ${applications} a
        where a.id = ${appId} and a.owner_id = ${worker.ownerId} and a.run_id = ${run.id}) then 'eligible' else 'duplicate' end`,
    }).where(and(eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.manifestId, id),
      eq(discoveryTargets.disposition, 'eligible')));
    const [missing] = await tx.select({ id: discoveryTargets.id }).from(discoveryTargets).where(and(
      eq(discoveryTargets.ownerId, worker.ownerId), eq(discoveryTargets.manifestId, id),
      inArray(discoveryTargets.disposition, ['eligible', 'duplicate']), sql`${discoveryTargets.applicationId} is null`,
    )).limit(1);
    if (missing) fail(409, 'STAGING_INCOMPLETE', 'Applications did not persist.');
    one(await tx.update(discoveryManifests).set({ state: 'ready' }).where(and(
      manifestScope(worker.ownerId, id), eq(discoveryManifests.revision, manifest.revision + 1),
      eq(discoveryManifests.stagedCount, manifest.candidateCount),
    )).returning());
    one(await tx.update(applicationRuns).set({
      discoveryState: 'ready', lastScanAt: manifest.capturedAt, captureUntil: now + DISCOVERY_INTERVAL_MS, discoveryError: null,
    }).where(and(runScope(worker.ownerId, run.id), eq(applicationRuns.revision, run.revision),
      eq(applicationRuns.currentManifestId, id))).returning());
  });
}

function capExceeded(policy: Policy, now: number) {
  const day = Math.floor(now / DAY_MS) * DAY_MS;
  return sql<boolean>`(
    (select count(*) from ${applications} used where used.owner_id = ${applications.ownerId}
      and used.started_at >= ${day} and used.started_at < ${day + DAY_MS}) >= ${policy.dailyApplicationCap}
    or (select count(*) from ${applications} used where used.owner_id = ${applications.ownerId}
      and used.started_at >= ${day} and used.started_at < ${day + DAY_MS}
      and (used.employer_key = ${applications.employerKey} or
        (used.ats = ${applications.ats} and used.tenant = ${applications.tenant}))) >= ${policy.perEmployerCap}
  )`;
}
export async function discoveryClaimAllowed(tx: WorkerTx, app: ApplicationRow, now: number): Promise<boolean> {
  if (!app.snapshotManifestId) return true; // Phase 3's private synthetic enqueue has no public route.
  const [manifest] = await tx.select({ state: discoveryManifests.state }).from(discoveryManifests)
    .where(manifestScope(app.ownerId, app.snapshotManifestId));
  if (!manifest || manifest.state !== 'ready' || await manuallySuppressed(tx, app)) return false;
  const [run] = await tx.select().from(applicationRuns).where(runScope(app.ownerId, app.runId));
  const policy = run && await currentDiscoveryPolicy(tx, run, now);
  if (!policy) return false;
  if (app.startedAt !== null) return true;
  const [{ held }] = await tx.select({ held: capExceeded(policy, now) }).from(applications)
    .where(and(eq(applications.ownerId, app.ownerId), eq(applications.id, app.id)));
  await tx.update(discoveryTargets).set({ disposition: held ? 'held_cap' : 'eligible' }).where(and(
    eq(discoveryTargets.ownerId, app.ownerId), eq(discoveryTargets.runId, app.runId),
    eq(discoveryTargets.applicationId, app.id), inArray(discoveryTargets.disposition, ['eligible', 'held_cap']),
  ));
  return !held;
}

export async function getDiscoveryStatus(db: PrivateDb, ownerId: string, runId: string, options: WorkerOptions = {}): Promise<DiscoveryStatus> {
  return workerTransaction(db, async (tx) => {
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    if (!run) fail(404, 'NOT_FOUND', 'Run not found.');
    const [manifest] = run.currentManifestId
      ? await tx.select().from(discoveryManifests).where(manifestScope(ownerId, run.currentManifestId)) : [];
    const now = nowAt(options), policy = await currentDiscoveryPolicy(tx, run, now);
    const disposition = sql<TargetDisposition>`case
      when ${discoveryTargets.disposition} in ('eligible','held_cap') and ${applications.startedAt} is null
        and ${applications.state} = 'queued' then
        ${policy ? sql`case when ${capExceeded(policy, now)} then 'held_cap' else 'eligible' end` : sql`'held_policy'`}
      else ${discoveryTargets.disposition} end`;
    const groups = await tx.select({ disposition, count: sql<number>`count(*)` })
      .from(discoveryTargets).leftJoin(applications, and(
        eq(applications.ownerId, discoveryTargets.ownerId), eq(applications.id, discoveryTargets.applicationId),
      )).where(and(eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.runId, runId)))
      .groupBy(disposition);
    const counts = { eligible: 0, duplicate: 0, unresolved: 0, held_policy: 0, held_cap: 0, manual_reported: 0 };
    for (const group of groups) counts[group.disposition] = group.count;
    return DiscoveryStatusSchema.parse({
      ownerId, runId, state: run.discoveryState, lastAttemptAt: run.lastAttemptAt, lastScanAt: run.lastScanAt,
      errorCode: run.discoveryError, manifestId: manifest?.id ?? null, manifestHash: manifest?.hash ?? null,
      capturedAt: manifest?.capturedAt ?? null, candidateCount: manifest?.candidateCount ?? 0,
      stagedCount: manifest?.stagedCount ?? 0, counts, capAccounting: 'started_per_utc_day',
    });
  });
}

export async function abandonDiscovery(db: PrivateDb, ownerId: string, runId: string, input: unknown, options: WorkerOptions = {}) {
  const command = AbandonDiscoverySchema.parse(input);
  return workerTransaction(db, async (tx) => {
    const replay = await replayCommand<{ runId: string; manifestId: string; state: 'abandoned' }>(tx, ownerId, `discovery:abandon:${runId}`, command);
    if (replay) return replay;
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    const [manifest] = await tx.select().from(discoveryManifests).where(and(
      manifestScope(ownerId, command.manifestId), eq(discoveryManifests.runId, runId),
    ));
    if (!run || !manifest) fail(404, 'NOT_FOUND', 'Discovery manifest not found.');
    if (manifest.state !== 'staging' || run.currentManifestId !== manifest.id) fail();
    // Ending this run preserves its immutable targets; a replacement run gets fresh target keys.
    one(await tx.update(discoveryManifests).set({ state: 'abandoned', revision: manifest.revision + 1 })
      .where(and(manifestScope(ownerId, manifest.id), eq(discoveryManifests.revision, manifest.revision))).returning());
    one(await tx.update(applicationRuns).set({
      state: 'stopped', revision: run.revision + 1, discoveryState: 'abandoned', captureToken: null, captureUntil: null,
    })
      .where(and(runScope(ownerId, runId), eq(applicationRuns.revision, run.revision))).returning());
    await releaseRunApplications(tx, ownerId, runId, 'stopped');
    const acknowledgement = AbandonDiscoveryResponseSchema.parse({ runId, manifestId: manifest.id, state: 'abandoned' });
    await saveCommand(tx, ownerId, `discovery:abandon:${runId}`, command, acknowledgement, nowAt(options));
    return acknowledgement;
  });
}

export async function reapplyApplication(
  db: PrivateDb, ownerId: string, runId: string, input: ReapplyRequest, options: WorkerOptions = {},
) {
  const command = ReapplyRequestSchema.parse(input), scope = `application:reapply:${runId}`;
  const result = await workerTransaction(db, async (tx) => {
    const replay = await replayCommand<ReturnType<typeof applicationSummary>>(tx, ownerId, scope, command);
    if (replay) return replay;
    const [run] = await tx.select().from(applicationRuns).where(runScope(ownerId, runId));
    if (!run) fail(404, 'NOT_FOUND', 'Run not found.');
    const [worker] = await tx.select().from(workers).where(and(eq(workers.ownerId, ownerId), eq(workers.id, run.workerId)));
    if (!worker || !await currentWorker(tx, worker, options)) return new WorkerError(403, 'FORBIDDEN', 'Worker is revoked.');
    const now = nowAt(options), policy = await currentDiscoveryPolicy(tx, run, now);
    if (!policy?.reapplication.allowed) fail(403, 'REAPPLICATION_DISABLED', 'Policy does not permit reapplication.');
    const [previous] = await tx.select().from(applications).where(and(
      eq(applications.ownerId, ownerId), eq(applications.id, command.previousApplicationId),
    ));
    if (!previous) fail(404, 'NOT_FOUND', 'Previous application not found.');
    if (previous.revision !== command.expectedRevision || !isTerminalState(previous.state) || previous.leaseUntil !== null) fail();
    const [latest] = await tx.select().from(applications).where(identityMatch(previous)).orderBy(desc(applications.attempt)).limit(1);
    if (latest.id !== previous.id || await manuallySuppressed(tx, previous)) fail(409, 'DUPLICATE_BLOCKED', 'Application is suppressed.');
    const [event] = await tx.select({ latest: sql<number | null>`max(${applicationEvents.createdAt})` }).from(applicationEvents)
      .where(and(eq(applicationEvents.ownerId, ownerId), eq(applicationEvents.applicationId, previous.id)));
    const [terminalCommand] = await tx.select({ latest: sql<number | null>`max(${workerCommands.createdAt})` }).from(workerCommands)
      .where(and(eq(workerCommands.ownerId, ownerId), sql`(
        (json_extract(${workerCommands.acknowledgement}, '$.id') = ${previous.id}
          and json_extract(${workerCommands.acknowledgement}, '$.state') in ('submitted','failed','skipped','cancelled'))
        or (json_extract(${workerCommands.acknowledgement}, '$.id') = ${previous.runId}
          and json_extract(${workerCommands.acknowledgement}, '$.state') = 'stopped')
        or (json_extract(${workerCommands.acknowledgement}, '$.runId') = ${previous.runId}
          and json_extract(${workerCommands.acknowledgement}, '$.state') = 'abandoned'))`));
    if (now - Math.max(previous.createdAt, previous.startedAt ?? 0, event.latest ?? 0, terminalCommand.latest ?? 0) < policy.reapplication.minimumDays * DAY_MS) {
      fail(409, 'COOLDOWN', 'Reapplication cooldown has not elapsed.');
    }
    const [target] = await tx.select().from(discoveryTargets).where(and(
      eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.runId, runId), eq(discoveryTargets.ats, previous.ats),
      eq(discoveryTargets.tenant, previous.tenant), eq(discoveryTargets.requisition, previous.requisition),
      inArray(discoveryTargets.disposition, ['duplicate', 'eligible', 'held_cap']),
    )).limit(1);
    const [manifest] = target ? await tx.select().from(discoveryManifests).where(manifestScope(ownerId, target.manifestId)) : [];
    if (!target || !manifest || manifest.state !== 'ready' || hashValue(manifest.artifact) !== manifest.hash) {
      fail(409, 'DISCOVERY_REQUIRED', 'A complete matching discovery snapshot is required.');
    }
    const candidate = manifest.artifact.candidates[target.candidateIndex];
    if (!candidate || candidate.disposition !== 'candidate' || hashValue(candidate) !== target.candidateHash) fail();
    const row = one(await tx.insert(applications).values({
      id: randomUUID(), ownerId, runId, workerId: run.workerId, ats: previous.ats, tenant: previous.tenant,
      requisition: previous.requisition, attempt: previous.attempt + 1, previousApplicationId: previous.id,
      snapshotManifestId: target.manifestId, snapshotTargetKey: target.targetKey, snapshotHash: target.candidateHash,
      employerKey: target.employerKey, availableAt: now, createdAt: now,
    }).returning());
    one(await tx.update(discoveryTargets).set({ applicationId: row.id, disposition: 'eligible' })
      .where(and(eq(discoveryTargets.ownerId, ownerId), eq(discoveryTargets.id, target.id))).returning());
    const acknowledgement = applicationSummary(row);
    await saveCommand(tx, ownerId, scope, command, acknowledgement, now);
    return acknowledgement;
  });
  if (result instanceof WorkerError) throw result;
  return result;
}
