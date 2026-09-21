import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, gte, isNull, sql } from 'drizzle-orm';
import type { PrivateDb } from '../private-db/index.ts';
import { documents, profileHeads, profileVersions, policyHeads, policyVersions, policyCommands, workers } from '../private-db/schema.ts';
import { createEmptyProfile, ProfileSchema, ProfileSaveSchema, profileEnablementIssues, type Profile, type ProfileResponse, type ProfileSave } from './profile.ts';
import { createEmptyPolicy, PolicySchema, PolicySaveSchema, PolicyCommandSchema, type PolicyResponse, type PolicySave, type PolicyCommand } from './policy.ts';
import { readDraftKeyConfig } from './draft-key.ts';
import { PrivateInputError } from './private-http.ts';
import { HEARTBEAT_MS } from './worker-protocol.ts';

type Db = Pick<PrivateDb, 'select' | 'insert' | 'update'>;
async function transaction<T>(db: PrivateDb, run: Parameters<PrivateDb['transaction']>[0]): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      // Native WAL avoids read/commit lock contention across local async connections.
      // Hosted libSQL manages its own journal; no hosted PRAGMA is issued.
      if (db.$client.protocol === 'file') await db.run(sql`pragma journal_mode = WAL`);
      return await db.transaction(run) as T;
    }
    catch (error) {
      let cause: unknown = error;
      while (cause && typeof cause === 'object' && !('code' in cause) && 'cause' in cause) cause = cause.cause;
      if (attempt >= 3 || !cause || typeof cause !== 'object' || !('code' in cause) || cause.code !== 'SQLITE_BUSY') throw error;
      // Retry the rolled-back transaction, not individual writes or ambiguous network failures.
      await new Promise((resolve) => setTimeout(resolve, 10 * 3 ** attempt));
    }
  }
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, v]) => `${JSON.stringify(key)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function hashValue(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}
function conflict(): never { throw new PrivateInputError(409, 'Revision or request conflict. Reload before saving.'); }
function owner(ownerId: string) {
  if (!ownerId || ownerId.length > 256) throw new PrivateInputError(403, 'Applicant required.');
}
function bound(value: unknown) {
  if (Buffer.byteLength(JSON.stringify(value)) > 128 * 1024) throw new PrivateInputError(413, 'Request too large.');
}
async function validateDocumentReferences(db: Db, ownerId: string, profile: Profile) {
  const references = new Map<string, number>();
  function add(id: string, version: number) {
    if (references.has(id) && references.get(id) !== version) throw new PrivateInputError(400, 'Conflicting document versions.');
    references.set(id, version);
  }
  function visit(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== 'object') return;
    const obj = value as Record<string, unknown>;
    if ('state' in obj) {
      const f = obj as { type: string; value: { documentId: string; version: number } | null;
        provenance: { source: string; sourceId: string | null; sourceVersion: number | null } };
      if (f.type === 'document' && f.value) add(f.value.documentId, f.value.version);
      if (f.provenance.source === 'document' && f.provenance.sourceId && f.provenance.sourceVersion) {
        add(f.provenance.sourceId, f.provenance.sourceVersion);
      }
      return;
    }
    Object.values(obj).forEach(visit);
  }
  visit(profile);
  for (const [id, version] of references) {
    const [row] = await db.select({ id: documents.id }).from(documents).where(and(
      eq(documents.ownerId, ownerId), eq(documents.id, id), eq(documents.version, version), eq(documents.state, 'available'),
    ));
    if (!row) throw new PrivateInputError(403, 'Document reference is not available to this applicant.');
  }
}

export async function getProfile(db: Db, ownerId: string): Promise<ProfileResponse> {
  owner(ownerId);
  const [row] = await db.select({ revision: profileVersions.revision, profile: profileVersions.profile })
    .from(profileHeads).innerJoin(profileVersions, and(eq(profileVersions.ownerId, profileHeads.ownerId),
      eq(profileVersions.revision, profileHeads.revision))).where(eq(profileHeads.ownerId, ownerId));
  return { revision: row?.revision ?? 0, profile: row ? ProfileSchema.parse(row.profile) : createEmptyProfile(), ownerId };
}

/** IDs survive reorder; revisions/timestamps are assigned by the server on explicit saves. */
function versionProfile(previous: Profile | null, next: Profile, now: string): Profile {
  type Item = { id: string; version: number; [key: string]: unknown };
  const old = new Map<string, { item: Item; path: string }>();
  const oldPaths = new Map<string, string>();
  function walk(value: unknown, path: string, update: boolean): void {
    if (Array.isArray(value)) {
      value.forEach((item) => walk(item, `${path}.${(item as Item).id}`, update));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const item = value as Item;
    const prior = item.id ? old.get(item.id) : undefined;
    if (item.id && !update) { old.set(item.id, { item, path }); oldPaths.set(path, item.id); }
    if (item.id && update) {
      if (oldPaths.has(path) && oldPaths.get(path) !== item.id) conflict();
      if (prior && (prior.path !== path || item.version !== prior.item.version)) conflict();
      if (!prior && item.version !== 1) conflict();
      const withoutVersion = (v: Item) => Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'version' && k !== 'confirmedAt'));
      const changed = !prior || canonical(withoutVersion(item)) !== canonical(withoutVersion(prior.item));
      item.version = prior ? prior.item.version + Number(changed) : 1;
      if ('state' in item) item.confirmedAt = item.state === 'confirmed'
        ? (changed ? now : prior?.item.confirmedAt ?? now) : null;
    }
    if ('state' in item) return;
    for (const [key, child] of Object.entries(item)) walk(child, `${path}.${key}`, update);
  }
  if (previous) walk(previous, '', false);
  const result = structuredClone(next);
  walk(result, '', true);
  return ProfileSchema.parse(result);
}

export async function saveProfile(db: PrivateDb, ownerId: string, input: ProfileSave): Promise<ProfileResponse> {
  owner(ownerId); readDraftKeyConfig(); bound(input);
  const command = ProfileSaveSchema.parse(input);
  const requestHash = hashValue(command);
  return transaction<ProfileResponse>(db, async (tx) => {
    const [retry] = await tx.select().from(profileVersions)
      .where(and(eq(profileVersions.ownerId, ownerId), eq(profileVersions.requestId, command.requestId)));
    if (retry) {
      if (retry.requestHash !== requestHash) conflict();
      return { revision: retry.revision, profile: ProfileSchema.parse(retry.profile), ownerId };
    }
    const current = await getProfile(tx, ownerId);
    if (current.revision !== command.expectedRevision) conflict();
    const profile = versionProfile(current.revision ? current.profile : null, command.profile, new Date().toISOString());
    await validateDocumentReferences(tx, ownerId, profile);
    bound(profile);
    const revision = current.revision + 1;
    await tx.insert(profileVersions).values({ ownerId, revision, requestId: command.requestId, requestHash, profile, createdAt: Date.now() });
    if (!current.revision) {
      const rows = await tx.insert(profileHeads).values({ ownerId, revision }).onConflictDoNothing().returning();
      if (!rows.length) conflict();
    } else {
      const rows = await tx.update(profileHeads).set({ revision })
        .where(and(eq(profileHeads.ownerId, ownerId), eq(profileHeads.revision, current.revision))).returning();
      if (!rows.length) conflict();
    }
    return { ownerId, revision, profile };
  });
}

export async function getPolicy(db: Db, ownerId: string, now = Date.now()): Promise<PolicyResponse> {
  owner(ownerId);
  const [runner] = await db.select({ id: workers.id }).from(workers).where(and(
    eq(workers.ownerId, ownerId), isNull(workers.revokedAt), gte(workers.lastSeenAt, now - HEARTBEAT_MS * 3),
  )).limit(1);
  const runnerAvailable = Boolean(runner);
  const [row] = await db.select().from(policyHeads).innerJoin(policyVersions,
    and(eq(policyHeads.ownerId, policyVersions.ownerId), eq(policyHeads.policyVersion, policyVersions.version)))
    .where(eq(policyHeads.ownerId, ownerId));
  if (!row) return {
    revision: 0, policy: createEmptyPolicy(), enabled: false, policyVersion: 0, policyHash: null,
    acceptedPolicyVersion: null, acceptedPolicyHash: null, acceptedAt: null, runnerAvailable,
  };
  const head = row.private_policy_head;
  const saved = row.private_policy_version;
  const policy = PolicySchema.parse(saved.policy);
  const enabled = head.enabled && head.acceptedPolicyVersion === saved.version &&
    head.acceptedPolicyHash === saved.hash && saved.hash === hashValue(policy) &&
    (!policy.expiresAt || Date.parse(policy.expiresAt) > now);
  return {
    revision: head.revision, policyVersion: saved.version, policyHash: saved.hash, policy, enabled,
    acceptedPolicyVersion: head.acceptedPolicyVersion, acceptedPolicyHash: head.acceptedPolicyHash,
    acceptedAt: head.acceptedAt === null ? null : new Date(head.acceptedAt).toISOString(), runnerAvailable,
  };
}

export async function mutatePolicy(
  db: PrivateDb, ownerId: string, input: PolicySave | PolicyCommand,
): Promise<PolicyResponse> {
  owner(ownerId); readDraftKeyConfig(); bound(input);
  const command = 'policy' in input ? PolicySaveSchema.parse(input) : PolicyCommandSchema.parse(input);
  const requestHash = hashValue(command);
  return transaction<PolicyResponse>(db, async (tx) => {
    const [retry] = await tx.select().from(policyCommands)
      .where(and(eq(policyCommands.ownerId, ownerId), eq(policyCommands.requestId, command.requestId)));
    if (retry) {
      if (retry.requestHash !== requestHash) conflict();
      // Original acknowledgement is historical, never authority for later execution.
      return retry.acknowledgement as PolicyResponse;
    }
    const current = await getPolicy(tx, ownerId);
    if (current.revision !== command.expectedRevision) conflict();
    const now = Date.now();
    let policyVersion = current.policyVersion;
    let acceptedPolicyVersion: number | null = null;
    let acceptedPolicyHash: string | null = null;
    let acceptedAt: number | null = null;
    const enabled = 'action' in command && command.action === 'enable';
    if ('policy' in command || !policyVersion) {
      if (enabled) throw new PrivateInputError(409, 'Save a policy before enabling.');
      policyVersion += 1;
      const policy = 'policy' in command ? command.policy : current.policy;
      await tx.insert(policyVersions).values({ ownerId, version: policyVersion, policy, hash: hashValue(policy), createdAt: now });
    }
    if (enabled) {
      if (!command.acceptedPolicyHash || command.acceptedPolicyHash !== current.policyHash) conflict();
      if (current.policy.expiresAt && Date.parse(current.policy.expiresAt) <= now) {
        throw new PrivateInputError(409, 'Policy has expired.');
      }
      const profile = await getProfile(tx, ownerId);
      if (profileEnablementIssues(profile.profile).length) throw new PrivateInputError(409, 'Confirm required identity and contact fields first.');
      if (!current.policy.actions.length || !current.policy.destinations.length || !current.policy.countries.length) {
        throw new PrivateInputError(409, 'Choose permitted actions, destinations and countries first.');
      }
      acceptedPolicyVersion = policyVersion; acceptedPolicyHash = current.policyHash; acceptedAt = now;
    }
    const revision = current.revision + 1;
    const next = { revision, policyVersion, enabled, acceptedPolicyVersion, acceptedPolicyHash, acceptedAt };
    if (!current.revision) {
      const rows = await tx.insert(policyHeads).values({ ownerId, ...next }).onConflictDoNothing().returning();
      if (!rows.length) conflict();
    } else {
      const rows = await tx.update(policyHeads).set(next)
        .where(and(eq(policyHeads.ownerId, ownerId), eq(policyHeads.revision, current.revision))).returning();
      if (!rows.length) conflict();
    }
    const acknowledgement = await getPolicy(tx, ownerId, now);
    await tx.insert(policyCommands).values({ ownerId, requestId: command.requestId, requestHash, revision, acknowledgement, createdAt: now });
    return acknowledgement;
  });
}

/** Execution must re-read the live head; an old acknowledgement is not authorization. */
export async function requireActivePolicy(db: PrivateDb, ownerId: string, version: number, hash: string) {
  const current = await getPolicy(db, ownerId);
  if (!current.enabled || current.policyVersion !== version || current.policyHash !== hash) {
    throw new PrivateInputError(403, 'Policy is disabled, expired or no longer accepted.');
  }
  return current.policy;
}
