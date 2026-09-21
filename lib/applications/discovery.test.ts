import { existsSync, mkdtempSync, renameSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../db/index.ts';
import { postings } from '../db/schema.ts';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import {
  account, applications, applicationRuns, applicationEvents, policyHeads, policyVersions, user,
  discoveryManifests, discoveryTargets, manualApplicationMarks, legacyImportPreviews,
} from '../private-db/schema.ts';
import { createEmptyPolicy, type Policy } from './policy.ts';
import { hashValue } from './stores.ts';
import { createPairing, pairWorker, revokeWorker } from './pairing.ts';
import { createRun, commandRun, commandApplication } from './runs.ts';
import { pollWorker, heartbeatWorker } from './leases.ts';
import { recordWorkerEvent } from './events.ts';
import {
  discoverWorkerRuns, stageDiscoveryManifest, getDiscoveryStatus, abandonDiscovery, reapplyApplication,
  DISCOVERY_INTERVAL_MS,
} from './discovery.ts';
import { previewLegacyImport, confirmLegacyImport } from './imports.ts';
import { ImportConfirmRequestSchema, ImportPreviewRequestSchema, IMPORT_PREVIEW_TTL_MS } from './discovery-protocol.ts';
import * as source from './discovery-source.ts';
import { getDiscoveryCorpus } from './discovery-corpus.ts';
import type { WorkerOptions } from './worker-store.ts';
import type { Lease } from './worker-protocol.ts';

vi.mock('server-only', () => ({}));
let db: PrivateDb, other: PrivateDb, corpus: Db, dir: string, now: number, options: WorkerOptions;
const DAY = 86_400_000;
const request = () => ({ requestId: randomUUID() });
const secret = () => randomBytes(32).toString('base64url');
const ref = (lease: Lease) => ({ applicationId: lease.applicationId, fence: lease.fence, expectedRevision: lease.revision });
const provider = () => corpus;
const appRows = () => db.select().from(applications);
const manifests = () => db.select().from(discoveryManifests);
const targets = () => db.select().from(discoveryTargets);
function addPostings(count: number, start = 1, sameTenant = false) {
  corpus.insert(postings).values(Array.from({ length: count }, (_, i) => ({
    id: start + i, dedupeKey: `fixture-${start + i}`, canonicalUrl: `https://boards.greenhouse.io/${sameTenant ? 'shared' : `tenant${start + i}`}/jobs/${start + i}`,
    postedAt: new Date(now), firstSeenRun: 'synthetic', company: sameTenant ? 'Same Employer' : `Employer ${start + i}`,
    title: 'Software Engineer', companyNorm: `employer${start + i}`, titleNorm: 'software engineer', locationKey: 'US',
    country: 'US', track: 'engineering' as const, paid: true,
  }))).run();
}
async function policyFor(ownerId = 'alice', overrides: Partial<Policy> = {}) {
  const policy: Policy = { ...createEmptyPolicy(), actions: ['read_jobs'], undisclosedPay: 'include', ...overrides };
  const hash = hashValue(policy);
  await db.insert(policyVersions).values({ ownerId, version: 1, hash, policy, createdAt: now });
  await db.insert(policyHeads).values({ ownerId, revision: 1, policyVersion: 1, enabled: true,
    acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
}
async function prepared(ownerId = 'alice', overrides: Partial<Policy> = {}) {
  await policyFor(ownerId, overrides);
  const grant = await createPairing(db, ownerId, { ...request(), expectedRevision: 0, label: 'Synthetic' }, options);
  const token = secret();
  const worker = await pairWorker(db, {
    ...request(), protocolVersion: 1, workerId: randomUUID(), grant: grant.grant, workerToken: token,
    workerVersion: '0.1.0', capabilities: ['control-v1'],
  }, options);
  const run = await createRun(db, ownerId, { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
  return { run, worker, token };
}
async function complete(token: string, runId: string) {
  for (let i = 0; i < 60; i++) {
    await discoverWorkerRuns(db, token, provider, options);
    if ((await getDiscoveryStatus(db, 'alice', runId, options)).state === 'ready') return;
  }
  throw new Error('Discovery did not finish');
}
async function poll(token: string, discover = false) {
  return pollWorker(db, token, { protocolVersion: 1 }, { ...options, ...(discover ? { corpus: provider } : {}) });
}
async function skip(id: string) {
  const [app] = await db.select().from(applications).where(eq(applications.id, id));
  return commandApplication(db, app.ownerId, app.runId, id, { ...request(), expectedRevision: app.revision, action: 'skip' }, options);
}
async function preview(ids: number[], ownerId = 'alice') {
  return previewLegacyImport(db, ownerId, provider, { ...request(), postingIds: ids }, options);
}
const confirmInput = (p: Awaited<ReturnType<typeof preview>>, ids = p.rows.map((r) => r.postingId)) => ({
  ...request(), previewToken: p.previewToken, previewHash: p.previewHash, postingIds: ids, confirmOwnership: true as const,
});
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phase4-backend-'));
  now = Date.UTC(2026, 8, 21, 12);
  options = { now: () => now, isAllowedApplicant: (email) => ['alice@example.test', 'bob@example.test'].includes(email) };
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden'); }));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  corpus = openDb(join(dir, 'synthetic-corpus.db'), { migrate: true });
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
    await db.insert(account).values({ id: `${id}-credential`, userId: id, accountId: id, providerId: 'credential', password: secret() });
  }
});
afterEach(() => {
  (corpus as Db & { $client: Database.Database })?.$client.close(); other?.$client.close(); db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
});

describe('immutable complete cohorts and standing reconciliation', () => {
  it('captures 601 unique requisitions plus duplicate rows; commits the manifest before staging and claims only all-ready', async () => {
    const { token, run, worker } = await prepared();
    addPostings(601); addPostings(50, 602);
    for (let i = 0; i < 50; i++) corpus.update(postings).set({ canonicalUrl: `https://boards.greenhouse.io/tenant${i + 1}/jobs/${i + 1}?utm_source=duplicate` })
      .where(eq(postings.id, 602 + i)).run();
    expect((await poll(token, true)).lease).toBeNull();
    const [manifest] = await manifests();
    expect(manifest).toMatchObject({ candidateCount: 601, stagedCount: 200, state: 'staging', capturedAt: now });
    expect(manifest.hash).toBe(hashValue(manifest.artifact));
    expect(await appRows()).toHaveLength(0);
    expect(await targets()).toHaveLength(200);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).lastScanAt).toBeNull();
    db.$client.close();
    db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    for (const n of [400, 600]) {
      expect((await poll(token, true)).lease).toBeNull();
      expect((await manifests())[0].stagedCount).toBe(n);
      expect(await appRows()).toHaveLength(0);
    }
    expect((await poll(token, true)).lease).not.toBeNull();
    expect(await appRows()).toHaveLength(601);
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, state: 'ready', stagedCount: 601 });
    await stageDiscoveryManifest(other, token, manifest.id, options);
    const overlapping = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, overlapping.id);
    expect(await appRows()).toHaveLength(601);
    expect((await getDiscoveryStatus(db, 'alice', overlapping.id, options)).counts.duplicate).toBe(601);
    now += DISCOVERY_INTERVAL_MS + 1;
    await complete(token, run.id);
    expect(await appRows()).toHaveLength(601);
  }, 30_000);

  it('rolls back a failed final chunk and retries the exact hash without advancing progress or clocks', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    await db.run(sql`create trigger fixture_fail_application before insert on private_application begin select raise(abort,'synthetic failure'); end`);
    await expect(stageDiscoveryManifest(db, token, manifest.id, options)).rejects.toThrow();
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, stagedCount: 200, state: 'staging' });
    expect(await targets()).toHaveLength(200);
    expect(await appRows()).toHaveLength(0);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).lastScanAt).toBeNull();
    await db.run(sql`drop trigger fixture_fail_application`);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect(await appRows()).toHaveLength(201);
  });

  it('retains frozen identities through corpus deletion/reused numeric IDs and discovers new arrivals later', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    corpus.delete(postings).where(eq(postings.id, 201)).run();
    addPostings(1, 201);
    corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/replacement/jobs/9999' }).where(eq(postings.id, 201)).run();
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await appRows()).some((a) => a.requisition === '201')).toBe(true);
    expect((await appRows()).some((a) => a.requisition === '9999')).toBe(false);
    now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    await complete(token, run.id);
    expect(await appRows()).toHaveLength(202);
    expect((await manifests())[0].hash).toBe(manifest.hash);
  });

  it('reconsiders previously held work from a new snapshot without rewriting prior manifest evidence', async () => {
    const { token, run } = await prepared('alice', { undisclosedPay: 'ask' }); addPostings(1);
    corpus.update(postings).set({ paid: null }).run();
    await complete(token, run.id);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.held_policy).toBe(1);
    const [first] = await manifests();
    corpus.update(postings).set({ paid: true, payRateMin: 50 }).run(); now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    expect(await appRows()).toHaveLength(1);
    expect((await manifests()).find((m) => m.id === first.id)?.artifact).toEqual(first.artifact);
  });

  it.each(['DELETE', 'WAL'])('reconciles a replaced %s corpus instead of advancing the scan clock on a cached old inode', async (journal) => {
    const { token, run } = await prepared(); addPostings(1);
    const path = join(dir, 'synthetic-corpus.db'), replacement = join(dir, 'replacement.db');
    const writer = (corpus as Db & { $client: Database.Database }).$client;
    writer.pragma(`journal_mode = ${journal}`); writer.close();
    vi.stubEnv('WORKIE_DB', path); vi.stubEnv('TURSO_DATABASE_URL', '');
    const cached = getDiscoveryCorpus() as Db & { $client: Database.Database };
    let current = cached;
    try {
      await discoverWorkerRuns(db, token, getDiscoveryCorpus, options);
      const [first] = await manifests();
      const before = await previewLegacyImport(db, 'alice', getDiscoveryCorpus, { ...request(), postingIds: [1] }, options);
      const oldInode = statSync(path).ino;
      corpus = openDb(replacement, { migrate: true }); addPostings(2);
      corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/replaced/jobs/9001' }).where(eq(postings.id, 1)).run();
      const nextWriter = (corpus as Db & { $client: Database.Database }).$client;
      nextWriter.pragma(`journal_mode = ${journal}`); nextWriter.close();
      renameSync(path, `${path}.stale`);
      for (const suffix of ['-wal', '-shm']) {
        if (existsSync(`${path}${suffix}`)) renameSync(`${path}${suffix}`, `${path}.stale${suffix}`);
      }
      renameSync(replacement, path);
      expect(statSync(path).ino).not.toBe(oldInode);
      expect(cached.select().from(postings).all().map((p) => p.id)).toEqual([1]);
      now += DISCOVERY_INTERVAL_MS + 1;
      await discoverWorkerRuns(db, token, getDiscoveryCorpus, options);
      current = getDiscoveryCorpus() as typeof cached;
      expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
        state: 'ready', lastScanAt: now, candidateCount: 2, stagedCount: 2,
      });
      expect((await appRows()).map((a) => a.requisition).sort()).toEqual(['1', '2', '9001']);
      expect((await manifests()).find((m) => m.id === first.id)).toEqual(first);
      expect(current).not.toBe(cached);
      expect(cached.$client.open).toBe(false);
      expect(() => current.delete(postings).run()).toThrow(/readonly/i);
      const after = await previewLegacyImport(db, 'alice', getDiscoveryCorpus, { ...request(), postingIds: [1] }, options);
      expect(after.rows[0].identity?.requisition).toBe('9001');
      await confirmLegacyImport(db, 'alice', confirmInput(before), options);
      expect((await db.select().from(manualApplicationMarks))[0].requisition).toBe('1');
      renameSync(path, replacement);
      expect(() => getDiscoveryCorpus()).toThrow();
      renameSync(replacement, path);
      expect(getDiscoveryCorpus()).toBe(current);
    } finally {
      if (current.$client.open) current.$client.close();
      if (cached.$client.open) cached.$client.close();
    }
  });

  it('does not call the corpus provider for invalid or revoked workers or obsolete policy', async () => {
    const { token, worker } = await prepared(); const getCorpus = vi.fn(provider);
    await expect(discoverWorkerRuns(db, secret(), getCorpus, options)).rejects.toMatchObject({ status: 401 });
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    await discoverWorkerRuns(db, token, getCorpus, options);
    await revokeWorker(db, 'alice', worker.workerId, { ...request(), expectedRevision: 1 }, options);
    await expect(discoverWorkerRuns(db, token, getCorpus, options)).rejects.toMatchObject({ status: 401 });
    expect(getCorpus).not.toHaveBeenCalled();
  });

  it('backs off stale-policy staging so a replacement authorized run can complete', async () => {
    const { token, worker } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [stale] = await manifests();
    now += 1;
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    for (let i = 0; i < 4; i++) await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', replacement.id, options)).toMatchObject({
      state: 'ready', candidateCount: 201, stagedCount: 201, lastScanAt: now,
    });
    expect((await manifests()).find((m) => m.id === stale.id)).toEqual(stale);
    expect(await appRows()).toHaveLength(201);
    expect((await appRows()).every((app) => app.runId === replacement.id)).toBe(true);
  });

  it('reclaims an expired capture after a crash and preserves last successful scan on a failed capture', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const scanAt = now;
    now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, () => { throw new Error('synthetic unavailable'); }, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'failed', lastScanAt: scanAt, lastAttemptAt: now });
    await db.update(applicationRuns).set({ discoveryState: 'capturing', captureToken: randomUUID(), captureUntil: now - 1 })
      .where(eq(applicationRuns.id, run.id));
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', lastScanAt: now });
    expect(await appRows()).toHaveLength(1);
  });

  it('rejects an oversized corpus as a whole with a visible failure and no manifest or cursor', async () => {
    const { token, run } = await prepared();
    corpus.run(sql`with recursive n(i) as (select 1 union all select i + 1 from n where i <= 10000)
      insert into postings (dedupe_key,canonical_url,posted_at,first_seen_run,company,title,company_norm,title_norm,location_key,track,paid)
      select 'fixture-' || i, 'https://boards.greenhouse.io/fixture/jobs/' || i, ${now},
        'synthetic','Fixture','Engineer','fixture','engineer','US','engineering',1 from n`);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
      state: 'failed', errorCode: 'CAPTURE_FAILED', lastScanAt: null, candidateCount: 0, stagedCount: 0,
    });
    expect(await manifests()).toEqual([]);
    expect(await appRows()).toEqual([]);
  });

  it.each(['stop', 'policy', 'revoke'] as const)('rejects a capture completing after %s and never publishes its cohort', async (action) => {
    const { token, run, worker } = await prepared(); addPostings(1);
    const realCapture = source.captureCandidateSnapshot;
    vi.spyOn(source, 'captureCandidateSnapshot').mockImplementationOnce(async (...args) => {
      const snapshot = await realCapture(...args);
      if (action === 'stop') await commandRun(other, 'alice', run.id, { ...request(), expectedRevision: 1, action: 'stop' }, options);
      if (action === 'policy') await other.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
      if (action === 'revoke') await revokeWorker(other, 'alice', worker.workerId, { ...request(), expectedRevision: 1 }, options);
      return snapshot;
    });
    await discoverWorkerRuns(db, token, provider, options);
    expect(await manifests()).toEqual([]);
    expect(await targets()).toEqual([]);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).lastScanAt).toBeNull();
  });

  it('stops staging on policy change, supports explicit abandon, and never stages a stopped run', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    await db.update(policyHeads).set({ revision: 2 }).where(eq(policyHeads.ownerId, 'alice'));
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await manifests())[0].stagedCount).toBe(200);
    const command = { ...request(), manifestId: manifest.id };
    await expect(abandonDiscovery(db, 'bob', run.id, command, options)).rejects.toMatchObject({ status: 404 });
    const ack = await abandonDiscovery(db, 'alice', run.id, command, options);
    expect(await abandonDiscovery(other, 'alice', run.id, command, options)).toEqual(ack);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect(await appRows()).toEqual([]);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'abandoned', lastScanAt: null });
  });

  it('serializes two polls and preserves one manifest and one complete logical cohort', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await Promise.all([discoverWorkerRuns(db, token, provider, options), discoverWorkerRuns(other, token, provider, options)]);
    await complete(token, run.id);
    expect(await manifests()).toHaveLength(1);
    expect(await targets()).toHaveLength(201);
    expect(await appRows()).toHaveLength(201);
  });

  it.each(['stop', 'abandon'] as const)('%s closes incomplete discovery and fences earlier ready work in the same transaction', async (action) => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    addPostings(201, 2); now += DISCOVERY_INTERVAL_MS + 1;
    await discoverWorkerRuns(db, token, provider, options);
    const current = await getDiscoveryStatus(db, 'alice', run.id, options);
    expect(current.state).toBe('staging');
    if (action === 'stop') {
      await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: 1, action: 'stop' }, options);
    } else await abandonDiscovery(db, 'alice', run.id, { ...request(), manifestId: current.manifestId! }, options);
    expect((await appRows())[0]).toMatchObject({ state: 'cancelled', leaseUntil: null });
    expect((await appRows())[0].fence).toBeGreaterThan(lease.fence);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'abandoned', lastScanAt: current.lastScanAt });
    await stageDiscoveryManifest(db, token, current.manifestId!, options);
    expect(await appRows()).toHaveLength(1);
  });

  it('pauses incomplete staging without losing its hash and resumes only the same authorized policy', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    const [manifest] = await manifests();
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: 1, action: 'pause' }, options);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, stagedCount: 200 });
    await commandRun(db, 'alice', run.id, { ...request(), expectedRevision: 2, action: 'resume' }, options);
    await stageDiscoveryManifest(db, token, manifest.id, options);
    expect((await manifests())[0]).toMatchObject({ hash: manifest.hash, state: 'ready' });
    expect(await appRows()).toHaveLength(201);
  });

  it('publishes a staging failure without advancing its cursor and retries on a later worker poll', async () => {
    const { token, run } = await prepared(); addPostings(201);
    await discoverWorkerRuns(db, token, provider, options);
    await db.run(sql`create trigger fixture_stage_fail before insert on private_application begin select raise(abort,'fixture'); end`);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({
      state: 'staging', errorCode: 'STAGING_FAILED', stagedCount: 200, lastScanAt: null,
    });
    await db.run(sql`drop trigger fixture_stage_fail`);
    await discoverWorkerRuns(db, token, provider, options);
    expect(await getDiscoveryStatus(db, 'alice', run.id, options)).toMatchObject({ state: 'ready', errorCode: null, stagedCount: 201 });
  });
});

describe('cap-held backlog and explicit historical attempts', () => {
  it('reports every held daily-cap target and releases the backlog on the next UTC day', async () => {
    const { token, run } = await prepared('alice', { dailyApplicationCap: 1 }); addPostings(205); await complete(token, run.id);
    const first = (await poll(token)).lease!; expect(first).not.toBeNull();
    let status = await getDiscoveryStatus(db, 'alice', run.id, options);
    expect(status.counts.held_cap).toBe(204);
    await skip(first.applicationId);
    expect((await poll(token)).lease).toBeNull();
    expect(await appRows()).toHaveLength(205);
    now = Math.floor(now / DAY) * DAY + DAY;
    status = await getDiscoveryStatus(db, 'alice', run.id, options);
    expect(status.counts.held_cap).toBe(0);
    expect((await poll(token)).lease).not.toBeNull();
  }, 20_000);

  it('enforces per-employer caps across runs while never charging a resumed lease twice', async () => {
    const { token, run } = await prepared('alice', { perEmployerCap: 1 }); addPostings(3, 1, true); await complete(token, run.id);
    const first = (await poll(token)).lease!;
    expect((await poll(token)).lease?.applicationId).toBe(first.applicationId);
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.held_cap).toBe(2);
    await skip(first.applicationId);
    expect((await poll(token)).lease).toBeNull();
    now += DAY;
    expect((await poll(token)).lease).not.toBeNull();
  });

  it('allows only explicit policy-approved reapplication after cooldown measured from the terminal command', async () => {
    const { token, run } = await prepared('alice', { reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    now += 2 * DAY;
    const previous = await skip(lease.applicationId);
    const command = { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision };
    await expect(reapplyApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ code: 'COOLDOWN' });
    now += DAY;
    const next = await reapplyApplication(db, 'alice', run.id, command, options);
    expect(next.id).not.toBe(previous.id);
    expect(await reapplyApplication(other, 'alice', run.id, command, options)).toEqual(next);
    const history = await appRows();
    expect(history.find((a) => a.id === previous.id)).toMatchObject({ state: 'skipped', attempt: 1 });
    expect(history.find((a) => a.id === next.id)).toMatchObject({ state: 'queued', attempt: 2, previousApplicationId: previous.id });
    await expect(reapplyApplication(db, 'alice', run.id, { ...command, ...request() }, options)).rejects.toMatchObject({ code: 'DUPLICATE_BLOCKED' });
    expect((await poll(token)).lease?.applicationId).toBe(next.id);
  });

  it('keeps default suppression even after cooldown and rejects cross-owner and unapproved reapply', async () => {
    const { token, run } = await prepared(); addPostings(1); await complete(token, run.id);
    const previous = await skip((await appRows())[0].id); now += 400 * DAY;
    const command = { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision };
    await expect(reapplyApplication(db, 'bob', run.id, command, options)).rejects.toMatchObject({ status: 404 });
    await expect(reapplyApplication(db, 'alice', run.id, command, options)).rejects.toMatchObject({ code: 'REAPPLICATION_DISABLED' });
    await discoverWorkerRuns(db, token, provider, options);
    expect(await appRows()).toHaveLength(1);
    expect((await poll(token)).lease).toBeNull();
  });

  it('counts an explicit abandonment as the terminal time when reapplying into a replacement run', async () => {
    const { token, run, worker } = await prepared('alice', { reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    const first = (await poll(token)).lease!;
    now += 2 * DAY; addPostings(201, 2);
    await discoverWorkerRuns(db, token, provider, options);
    const status = await getDiscoveryStatus(db, 'alice', run.id, options);
    await abandonDiscovery(db, 'alice', run.id, { ...request(), manifestId: status.manifestId! }, options);
    const [previous] = await db.select().from(applications).where(eq(applications.id, first.applicationId));
    const replacement = await createRun(db, 'alice', { ...request(), expectedRevision: 0, workerId: worker.workerId }, options);
    await complete(token, replacement.id);
    const command = { ...request(), previousApplicationId: previous.id, expectedRevision: previous.revision };
    await expect(reapplyApplication(db, 'alice', replacement.id, command, options)).rejects.toMatchObject({ code: 'COOLDOWN' });
    now += DAY;
    const next = await reapplyApplication(db, 'alice', replacement.id, command, options);
    expect(next.runId).toBe(replacement.id);
    expect((await appRows()).find((a) => a.id === first.applicationId)).toMatchObject({ state: 'cancelled', runId: run.id });
  });
});

describe('owner-confirmed frozen legacy imports', () => {
  it('freezes preview identity despite numeric reuse and preserves missing IDs as unresolved manual evidence', async () => {
    addPostings(1);
    const p = await preview([1, 999]);
    corpus.update(postings).set({ canonicalUrl: 'https://boards.greenhouse.io/changed/jobs/2000' }).run();
    const command = confirmInput(p);
    const result = await confirmLegacyImport(db, 'alice', command, options);
    expect(result).toMatchObject({ status: 'manual_reported', resolvedCount: 1, unresolvedCount: 1, importedPostingIds: [1, 999] });
    const marks = await db.select().from(manualApplicationMarks);
    expect(marks.find((m) => m.postingId === 1)).toMatchObject({ ats: 'greenhouse', tenant: 'tenant1', requisition: '1' });
    expect(marks.find((m) => m.postingId === 999)).toMatchObject({ ats: null, tenant: null, requisition: null });
    expect(await db.select().from(applicationEvents)).toEqual([]);
    expect(await appRows()).toEqual([]);
    now += IMPORT_PREVIEW_TTL_MS + 1;
    expect(await confirmLegacyImport(other, 'alice', command, options)).toEqual(result);
  });

  it('serializes raced previews and confirmations with exact retries; rejects altered commands, hashes, selections and other owners', async () => {
    addPostings(2);
    const input = { ...request(), postingIds: [1, 2] };
    const previews = await Promise.all([
      previewLegacyImport(db, 'alice', provider, input, options),
      previewLegacyImport(other, 'alice', provider, input, options),
    ]);
    expect(previews[0]).toEqual(previews[1]);
    expect(await db.select().from(legacyImportPreviews)).toHaveLength(1);
    const p = previews[0], command = confirmInput(p, [1]);
    await expect(confirmLegacyImport(db, 'bob', command, options)).rejects.toMatchObject({ status: 404 });
    await expect(confirmLegacyImport(db, 'alice', { ...command, postingIds: [3] }, options)).rejects.toMatchObject({ status: 400 });
    await expect(confirmLegacyImport(db, 'alice', { ...command, previewHash: '0'.repeat(64) }, options)).rejects.toMatchObject({ status: 409 });
    const acks = await Promise.all([confirmLegacyImport(db, 'alice', command, options), confirmLegacyImport(other, 'alice', command, options)]);
    expect(acks[0]).toEqual(acks[1]);
    expect(await db.select().from(manualApplicationMarks)).toHaveLength(1);
    await expect(confirmLegacyImport(db, 'alice', { ...command, postingIds: [2] }, options)).rejects.toMatchObject({ status: 409 });
    await expect(previewLegacyImport(db, 'alice', provider, { ...input, postingIds: [2] }, options)).rejects.toMatchObject({ status: 409 });
  });

  it('does not confirm expired previews or silently mint a replacement on retry', async () => {
    addPostings(1); const input = { ...request(), postingIds: [1] };
    const p = await previewLegacyImport(db, 'alice', provider, input, options);
    now = p.expiresAt;
    await expect(confirmLegacyImport(db, 'alice', confirmInput(p), options)).rejects.toMatchObject({ code: 'PREVIEW_EXPIRED' });
    const denied = vi.fn(() => { throw new Error('must not reread'); });
    expect(await previewLegacyImport(db, 'alice', denied, input, options)).toEqual(p);
    expect(denied).not.toHaveBeenCalled();
    expect(await db.select().from(manualApplicationMarks)).toEqual([]);
  });

  it.each(['screening', 'submitting'] as const)('fences an active %s import; preserves reconciliation and forbids stale events', async (state) => {
    const { token, run } = await prepared('alice', { reapplication: { allowed: true, minimumDays: 1 } });
    addPostings(1); await complete(token, run.id);
    const lease = (await poll(token)).lease!;
    if (state === 'submitting') await db.update(applications).set({ state }).where(eq(applications.id, lease.applicationId));
    const p = await preview([1]);
    await confirmLegacyImport(db, 'alice', confirmInput(p), options);
    const [app] = await appRows();
    expect(app).toMatchObject({ state: state === 'submitting' ? 'submission_unknown' : 'skipped', leaseUntil: null });
    expect(app.fence).toBeGreaterThan(lease.fence);
    await expect(heartbeatWorker(db, token, { protocolVersion: 1, lease: ref(lease) }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    await expect(recordWorkerEvent(db, token, lease.applicationId, {
      protocolVersion: 1, eventId: randomUUID(), fence: lease.fence, expectedRevision: lease.revision,
      state: 'screening', checkpoint: { stage: 'screening', sequence: 1 }, reasonCode: null,
    }, options)).rejects.toMatchObject({ code: 'LEASE_LOST' });
    const next = (await poll(token)).lease;
    if (state === 'submitting') expect(next?.mode).toBe('reconcile'); else expect(next).toBeNull();
    expect((await getDiscoveryStatus(db, 'alice', run.id, options)).counts.manual_reported).toBe(1);
    if (state === 'screening') {
      now += DAY;
      await expect(reapplyApplication(db, 'alice', run.id, {
        ...request(), previousApplicationId: app.id, expectedRevision: app.revision,
      }, options)).rejects.toMatchObject({ code: 'DUPLICATE_BLOCKED' });
    }
  });

  it('suppresses marks confirmed during staging and never suppresses another owner', async () => {
    const a = await prepared(); const b = await prepared('bob');
    addPostings(201); await discoverWorkerRuns(db, a.token, provider, options);
    const p = await preview([201]); await confirmLegacyImport(db, 'alice', confirmInput(p), options);
    await stageDiscoveryManifest(db, a.token, (await manifests())[0].id, options);
    expect(await db.select().from(applications).where(and(eq(applications.ownerId, 'alice'), eq(applications.requisition, '201')))).toEqual([]);
    await discoverWorkerRuns(db, b.token, provider, options);
    const [bm] = await db.select().from(discoveryManifests).where(eq(discoveryManifests.runId, b.run.id));
    await stageDiscoveryManifest(db, b.token, bm.id, options);
    expect(await db.select().from(applications).where(eq(applications.ownerId, 'bob'))).toHaveLength(201);
  });

  it('rejects unsafe IDs, duplicate selections and unconfirmed ownership at the command boundary', () => {
    for (const ids of [[], [0], [-1], [1.5], [Number.MAX_SAFE_INTEGER + 1], [1, 1], Array.from({ length: 1001 }, (_, i) => i + 1)]) {
      expect(ImportPreviewRequestSchema.safeParse({ ...request(), postingIds: ids }).success).toBe(false);
    }
    expect(ImportPreviewRequestSchema.safeParse({ ...request(), postingIds: [1], ownerId: 'bob' }).success).toBe(false);
    expect(ImportConfirmRequestSchema.safeParse({
      ...request(), previewToken: randomUUID(), previewHash: '0'.repeat(64), postingIds: [1], confirmOwnership: false,
    }).success).toBe(false);
  });
});
