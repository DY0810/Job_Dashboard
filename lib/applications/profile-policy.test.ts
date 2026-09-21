import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import { documents, profileVersions, policyVersions, policyHeads, user } from '../private-db/schema.ts';
import { createEmptyProfile, EducationSchema, EmploymentSchema, AuthorizationSchema, DisclosureSchema,
  PreciseDateSchema, ProfileSchema, effectiveProfile, profileEnablementIssues, type Profile } from './profile.ts';
import { createEmptyPolicy, PolicySchema } from './policy.ts';
import { getProfile, saveProfile, getPolicy, mutatePolicy, requireActivePolicy } from './stores.ts';
import { getDraftKey, readDraftKeyConfig } from './draft-key.ts';

vi.mock('server-only', () => ({}));
let dir: string;
let db: PrivateDb;
const requestId = () => crypto.randomUUID();
const at = '2026-09-20T12:00:00.000Z';
function confirmed<T extends { value: unknown; state: string; confirmedAt: string | null }>(fact: T, value: T['value']): T {
  return { ...fact, value, state: 'confirmed', confirmedAt: at };
}
function applicant(): Profile {
  const profile = createEmptyProfile();
  profile.identity.legalFirstName = confirmed(profile.identity.legalFirstName, 'Synthetic');
  profile.identity.legalLastName = confirmed(profile.identity.legalLastName, 'Applicant');
  profile.identity.personalEmail = confirmed(profile.identity.personalEmail, 'synthetic@example.test');
  return profile;
}
function policy() {
  return { ...createEmptyPolicy(), actions: ['read_jobs', 'submit'] as const,
    destinations: ['careers.example.test'], countries: ['US'] };
}
async function document(ownerId = 'one') {
  const id = requestId();
  await db.insert(documents).values({
    id, ownerId, masterId: id, version: 1, kind: 'resume_master', name: 'synthetic.pdf',
    objectKey: `documents/${id}`, storage: 'local', mime: 'application/pdf', size: 100,
    state: 'available', safetyCheck: 'passed', sha256: 'a'.repeat(64), createdAt: Date.now(),
  });
  return id;
}
beforeEach(async () => {
  dir = mkdtempSync(join(process.cwd(), 'logs/auto-apply-gate/profile-'));
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('WORKIE_DB', join(dir, 'corpus.db'));
  vi.stubEnv('TURSO_DATABASE_URL', '');
  vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', randomBytes(32).toString('base64'));
  vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '1');
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden.'); }));
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  await db.insert(user).values(['one', 'two'].map((id) => ({ id, name: id, email: `${id}@example.test` })));
});
afterEach(() => {
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('typed profile semantics', () => {
  it('round trips exactly nine sections and repeated entities without inferring optional answers', () => {
    const p = applicant();
    p.education.schools = [EducationSchema.parse({}), EducationSchema.parse({})];
    p.work.employment = [EmploymentSchema.parse({})];
    p.authorization.countries = [AuthorizationSchema.parse({})];
    p.disclosures.answers = [DisclosureSchema.parse({})];
    expect(Object.keys(p)).toHaveLength(10);
    expect(ProfileSchema.parse(JSON.parse(JSON.stringify(p)))).toEqual(p);
    expect(p.education.schools[0].id).not.toBe(p.education.schools[1].id);
    expect(profileEnablementIssues(p)).toEqual([]);
    expect(p.voluntary.disability.state).toBe('unknown');
    expect(() => ProfileSchema.parse({ ...p, extraFact: 'invented' })).toThrow();
  });
  it('rejects fabricated date precision, invalid GPA and wrong units', () => {
    for (const date of [
      { precision: 'month', value: '2026-09-20' }, { precision: 'day', value: '2026-02-29' },
      { precision: 'year', value: '26' }, { precision: 'month', value: '2026-13' },
    ]) expect(PreciseDateSchema.safeParse(date).success).toBe(false);
    expect(PreciseDateSchema.parse({ precision: 'month', value: '2026-09' }).value).toBe('2026-09');
    const school = EducationSchema.parse({});
    school.gpa = confirmed(school.gpa, { value: 4.5, scale: 4 });
    expect(EducationSchema.safeParse(school).success).toBe(false);
    school.gpa = confirmed(school.gpa, { value: 3.8, scale: 4 });
    expect(EducationSchema.safeParse(school).success).toBe(true);
    expect(EducationSchema.safeParse({ ...school, gpa: { ...school.gpa, units: 'percent' } }).success).toBe(false);
  });
  it('preserves candidates without exposing them as effective confirmed facts', () => {
    const p = applicant();
    p.identity.preferredName = {
      ...p.identity.preferredName, state: 'candidate', value: 'Imported',
      provenance: { source: 'document', sourceId: requestId(), sourceVersion: 1, excerpt: 'Imported' },
    };
    expect(ProfileSchema.parse(p).identity.preferredName.state).toBe('candidate');
    expect(effectiveProfile(p).identity.preferredName).toMatchObject({ state: 'unknown', value: null });
    expect(p.identity.preferredName.state).toBe('candidate');
    p.identity.preferredName.confirmedAt = at;
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });
  it('rejects duplicate fact IDs and scoped facts without destinations', () => {
    const p = applicant();
    p.identity.legalLastName.id = p.identity.legalFirstName.id;
    expect(ProfileSchema.safeParse(p).success).toBe(false);
    p.identity.legalLastName.id = requestId();
    p.identity.legalFirstName.scope.kind = 'employer';
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });
  it('keeps citizenship, residence, current and historical answers distinct', () => {
    const auth = AuthorizationSchema.parse({});
    auth.country = confirmed(auth.country, 'US');
    auth.residenceStatus = confirmed(auth.residenceStatus, 'Permanent resident');
    expect(auth.citizenship.state).toBe('unknown');
    const current = DisclosureSchema.parse({});
    current.timeframe = confirmed(current.timeframe, 'current');
    current.answer = confirmed(current.answer, false);
    const historical = DisclosureSchema.parse({});
    historical.timeframe = confirmed(historical.timeframe, 'ever');
    expect(historical.answer.state).toBe('unknown');
  });
  it('rejects completed-in-progress education and impossible date ordering without adding precision', () => {
    const p = applicant();
    const school = EducationSchema.parse({});
    school.status = confirmed(school.status, 'in_progress');
    school.completedAt = confirmed(school.completedAt, { precision: 'month', value: '2025-05' });
    p.education.schools = [school];
    expect(ProfileSchema.safeParse(p).success).toBe(false);
    school.completedAt = { ...school.completedAt, value: null, state: 'unknown', confirmedAt: null };
    school.enrollmentStart = confirmed(school.enrollmentStart, { precision: 'month', value: '2027-09' });
    school.expectedGraduation = confirmed(school.expectedGraduation, { precision: 'year', value: '2026' });
    expect(ProfileSchema.safeParse(p).success).toBe(false);
    school.enrollmentStart.value = { precision: 'year', value: '2026' };
    expect(ProfileSchema.safeParse(p).success).toBe(true);
  });
  it('requires country and employer-scoped reusable legal answers', () => {
    const p = applicant();
    const auth = AuthorizationSchema.parse({});
    auth.country = confirmed(auth.country, 'US');
    auth.citizenship = confirmed(auth.citizenship, false);
    p.authorization.countries = [auth];
    expect(ProfileSchema.safeParse(p).success).toBe(false);
    auth.citizenship.scope = { ...auth.citizenship.scope, kind: 'country', country: 'US' };
    expect(ProfileSchema.safeParse(p).success).toBe(true);
    const disclosure = DisclosureSchema.parse({});
    disclosure.answer = confirmed(disclosure.answer, false);
    p.disclosures.answers = [disclosure];
    expect(ProfileSchema.safeParse(p).success).toBe(false);
  });
});

describe('immutable async profile saves', () => {
  it('isolates owners, rejects absent owners, and returns original retries after later saves', async () => {
    const command = { expectedRevision: 0, requestId: requestId(), profile: applicant() };
    const first = await saveProfile(db, 'one', command);
    expect(first.revision).toBe(1);
    expect((await getProfile(db, 'two')).revision).toBe(0);
    const profile = structuredClone(first.profile);
    profile.identity.preferredName = confirmed(profile.identity.preferredName, 'New name');
    const second = await saveProfile(db, 'one', { expectedRevision: 1, requestId: requestId(), profile });
    expect(second.profile.identity.preferredName.version).toBe(2);
    expect(second.profile.identity.preferredName.id).toBe(first.profile.identity.preferredName.id);
    expect(await saveProfile(db, 'one', command)).toEqual(first);
    expect((await getProfile(db, 'one')).revision).toBe(2);
    await expect(saveProfile(db, 'absent', command)).rejects.toThrow();
    await expect(saveProfile(db, '', command)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects stale/out-of-order saves and request-ID reuse with a changed body', async () => {
    const command = { expectedRevision: 0, requestId: requestId(), profile: applicant() };
    await saveProfile(db, 'one', command);
    await expect(saveProfile(db, 'one', { ...command, requestId: requestId() })).rejects.toMatchObject({ status: 409 });
    const changed = structuredClone(command);
    changed.profile.identity.preferredName = confirmed(changed.profile.identity.preferredName, 'Changed');
    await expect(saveProfile(db, 'one', changed)).rejects.toMatchObject({ status: 409 });
    expect(await db.select().from(profileVersions)).toHaveLength(1);
  });
  it('serializes competing async writes with exactly one winner and a true conflict', async () => {
    const first = await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile: applicant() });
    const attempts = ['A', 'B'].map((name) => {
      const profile = structuredClone(first.profile);
      profile.identity.preferredName = confirmed(profile.identity.preferredName, name);
      return { expectedRevision: 1, requestId: requestId(), profile };
    });
    const results = await Promise.allSettled(attempts.map((input) => saveProfile(db, 'one', input)));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    expect((await getProfile(db, 'one')).revision).toBe(2);
  });
  it('requires explicit saves to confirm candidates and supports intentional clearing', async () => {
    const profile = applicant();
    profile.identity.preferredName = {
      ...profile.identity.preferredName, state: 'candidate', value: 'Candidate',
      provenance: { source: 'document', sourceId: await document(), sourceVersion: 1, excerpt: null },
    };
    const first = await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile });
    expect(first.profile.identity.preferredName.state).toBe('candidate');
    const next = structuredClone(first.profile);
    next.identity.preferredName = confirmed(next.identity.preferredName, 'Candidate');
    const second = await saveProfile(db, 'one', { expectedRevision: 1, requestId: requestId(), profile: next });
    expect(second.profile.identity.preferredName).toMatchObject({ state: 'confirmed', version: 2 });
    next.identity.preferredName = { ...second.profile.identity.preferredName, state: 'unknown', value: null, confirmedAt: null };
    const third = await saveProfile(db, 'one', { expectedRevision: 2, requestId: requestId(), profile: next });
    expect(third.profile.identity.preferredName).toMatchObject({ state: 'unknown', version: 3, value: null });
    await expect(db.update(profileVersions).set({ profile: createEmptyProfile() })).rejects.toThrow();
    await expect(db.delete(profileVersions)).rejects.toThrow();
  });
  it('rejects document and provenance references owned by another applicant', async () => {
    const id = await document('two');
    const profile = applicant();
    profile.identity.preferredName = {
      ...profile.identity.preferredName, state: 'candidate', value: 'Foreign candidate',
      provenance: { source: 'document', sourceId: id, sourceVersion: 1, excerpt: null },
    };
    await expect(saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile })).rejects.toMatchObject({ status: 403 });
    expect((await getProfile(db, 'one')).revision).toBe(0);
  });
  it('keeps concurrent identical retries idempotent', async () => {
    const input = { expectedRevision: 0, requestId: requestId(), profile: applicant() };
    const [a, b] = await Promise.all([saveProfile(db, 'one', input), saveProfile(db, 'one', input)]);
    expect(a).toEqual(b);
    expect(await db.select().from(profileVersions)).toHaveLength(1);
  });
  it('enforces CAS across independent clients, with durable acknowledgement after reopen', async () => {
    const other = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    const command = { expectedRevision: 0, requestId: requestId(), profile: applicant() };
    try {
      const [a, b] = await Promise.all([saveProfile(db, 'one', command), saveProfile(other, 'one', command)]);
      expect(a).toEqual(b);
      expect((await getProfile(other, 'one')).revision).toBe(1);
    } finally { other.$client.close(); }
    const reopened = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
    try { expect((await saveProfile(reopened, 'one', command)).revision).toBe(1); }
    finally { reopened.$client.close(); }
  });
  it('retains IDs on reordering and rejects moving IDs between unrelated fields', async () => {
    const profile = applicant();
    profile.education.schools = [EducationSchema.parse({}), EducationSchema.parse({})];
    const first = await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile });
    first.profile.education.schools.reverse();
    const second = await saveProfile(db, 'one', { expectedRevision: 1, requestId: requestId(), profile: first.profile });
    expect(second.profile.education.schools).toEqual(first.profile.education.schools);
    const temp = second.profile.identity.legalFirstName;
    second.profile.identity.legalFirstName = second.profile.identity.legalLastName;
    second.profile.identity.legalLastName = temp;
    await expect(saveProfile(db, 'one', { expectedRevision: 2, requestId: requestId(), profile: second.profile })).rejects.toMatchObject({ status: 409 });
  });
});

describe('explicit, version-bound policy commands', () => {
  it('defaults disabled, zero cost, skip accounts and no remote fallback', async () => {
    expect(await getPolicy(db, 'one')).toMatchObject({
      revision: 0, enabled: false, runnerAvailable: false,
      policy: { accountPolicy: 'skip_new_accounts', fallbackOrder: [], budget: { perDay: 0 } },
    });
    expect(PolicySchema.safeParse({ ...createEmptyPolicy(), fallbackOrder: ['unapproved'] }).success).toBe(false);
    const filters = { ...createEmptyPolicy().filters, level: ['senior+'] };
    expect(PolicySchema.safeParse({ ...createEmptyPolicy(), filters }).success).toBe(false);
    expect(PolicySchema.safeParse({ ...createEmptyPolicy(), filters: { ...filters, tab: 'design', basis: 'employed' } }).success).toBe(true);
  });
  it('requires saved-hash acceptance, disables on expansion, and preserves original acknowledgements', async () => {
    await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile: applicant() });
    const saved = await mutatePolicy(db, 'one', { expectedRevision: 0, requestId: requestId(), policy: PolicySchema.parse(policy()) });
    expect(saved).toMatchObject({ revision: 1, policyVersion: 1, enabled: false });
    await expect(mutatePolicy(db, 'one', { expectedRevision: 1, requestId: requestId(), action: 'enable' })).rejects.toMatchObject({ status: 409 });
    const command = { expectedRevision: 1, requestId: requestId(), action: 'enable' as const, acceptedPolicyHash: saved.policyHash! };
    const enabled = await mutatePolicy(db, 'one', command);
    expect(enabled).toMatchObject({ revision: 2, policyVersion: 1, enabled: true, runnerAvailable: false });
    expect(await requireActivePolicy(db, 'one', 1, saved.policyHash!)).toEqual(saved.policy);
    expect((await getPolicy(db, 'two')).enabled).toBe(false);
    const expanded = await mutatePolicy(db, 'one', { expectedRevision: 2, requestId: requestId(),
      policy: { ...saved.policy, dailyApplicationCap: 20 } });
    expect(expanded).toMatchObject({ revision: 3, policyVersion: 2, enabled: false, acceptedAt: null });
    expect(await mutatePolicy(db, 'one', command)).toEqual(enabled);
    expect((await getPolicy(db, 'one')).enabled).toBe(false);
    await expect(requireActivePolicy(db, 'one', 1, saved.policyHash!)).rejects.toMatchObject({ status: 403 });
    await expect(db.update(policyVersions).set({ hash: 'forged' })).rejects.toThrow();
    await expect(db.run(sql`update private_policy_command set revision = 99`)).rejects.toThrow();
  });
  it('blocks unconfirmed essentials, but never requires optional EEO', async () => {
    const saved = await mutatePolicy(db, 'one', { expectedRevision: 0, requestId: requestId(), policy: PolicySchema.parse(policy()) });
    await expect(mutatePolicy(db, 'one', { expectedRevision: 1, requestId: requestId(), action: 'enable', acceptedPolicyHash: saved.policyHash! }))
      .rejects.toMatchObject({ status: 409 });
    await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile: applicant() });
    expect((await mutatePolicy(db, 'one', { expectedRevision: 1, requestId: requestId(), action: 'enable', acceptedPolicyHash: saved.policyHash! })).enabled).toBe(true);
    const disabled = await mutatePolicy(db, 'one', { expectedRevision: 2, requestId: requestId(), action: 'disable' });
    expect(disabled).toMatchObject({ revision: 3, enabled: false, acceptedPolicyHash: null });
    await expect(requireActivePolicy(db, 'one', 1, saved.policyHash!)).rejects.toMatchObject({ status: 403 });
  });
  it('rejects expired policies and fails closed on stale/corrupt acceptance metadata', async () => {
    await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile: applicant() });
    const saved = await mutatePolicy(db, 'one', { expectedRevision: 0, requestId: requestId(),
      policy: { ...PolicySchema.parse(policy()), expiresAt: '2020-01-01T00:00:00.000Z' } });
    await expect(mutatePolicy(db, 'one', { expectedRevision: 1, requestId: requestId(), action: 'enable', acceptedPolicyHash: saved.policyHash! }))
      .rejects.toMatchObject({ status: 409 });
    await expect(db.update(policyHeads).set({ enabled: true }).where(eq(policyHeads.ownerId, 'one'))).rejects.toThrow();
  });
  it('serializes policy save/enable races and scopes retry IDs to their owner', async () => {
    await saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile: applicant() });
    const id = requestId();
    const saved = await mutatePolicy(db, 'one', { expectedRevision: 0, requestId: id, policy: PolicySchema.parse(policy()) });
    expect((await mutatePolicy(db, 'two', { expectedRevision: 0, requestId: id, policy: createEmptyPolicy() })).revision).toBe(1);
    const outcomes = await Promise.allSettled([
      mutatePolicy(db, 'one', { expectedRevision: 1, requestId: requestId(), action: 'enable', acceptedPolicyHash: saved.policyHash! }),
      mutatePolicy(db, 'one', { expectedRevision: 1, requestId: requestId(), policy: { ...saved.policy, dailyApplicationCap: 20 } }),
    ]);
    expect(outcomes.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.find((r) => r.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
  });
});

describe('owner-specific encrypted draft recovery', () => {
  it('derives stable separate keys, authenticates ciphertext, and invalidates old keys on rotation', async () => {
    const a = getDraftKey('one'), b = getDraftKey('two');
    expect(getDraftKey('one')).toEqual(a);
    expect(a.key).not.toBe(b.key);
    expect(a.key).not.toBe(process.env.WORKIE_DRAFT_ENCRYPTION_KEY);
    const importKey = (key: string) => crypto.subtle.importKey('raw', Buffer.from(key, 'base64'), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const iv = randomBytes(12);
    const additionalData = new TextEncoder().encode(JSON.stringify([a.ownerId, a.keyVersion]));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData }, await importKey(a.key), new TextEncoder().encode('private draft'));
    const decoded = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, await importKey(getDraftKey('one').key), cipher);
    expect(new TextDecoder().decode(decoded)).toBe('private draft');
    await expect(crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData }, await importKey(b.key), cipher)).rejects.toThrow();
    vi.stubEnv('WORKIE_DRAFT_KEY_VERSION', '2');
    expect(getDraftKey('one').key).not.toBe(a.key);
  });
  it('fails closed before profile/policy writes on missing, malformed or shared auth encryption keys', async () => {
    for (const value of ['', 'invalid', randomBytes(31).toString('base64')]) {
      vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', value);
      expect(readDraftKeyConfig).toThrow();
      await expect(saveProfile(db, 'one', { expectedRevision: 0, requestId: requestId(), profile: applicant() })).rejects.toThrow();
      await expect(mutatePolicy(db, 'one', { expectedRevision: 0, requestId: requestId(), policy: createEmptyPolicy() })).rejects.toThrow();
    }
    const same = randomBytes(32).toString('base64');
    vi.stubEnv('WORKIE_DRAFT_ENCRYPTION_KEY', same); vi.stubEnv('BETTER_AUTH_SECRET', same);
    expect(readDraftKeyConfig).toThrow();
    for (const equivalent of [` ${same} `, same.replace(/=+$/, ''), Buffer.from(same, 'base64').toString('hex')]) {
      vi.stubEnv('BETTER_AUTH_SECRET', equivalent);
      expect(readDraftKeyConfig).toThrow();
    }
    expect(await db.select().from(profileVersions)).toHaveLength(0);
    expect(await db.select().from(policyVersions)).toHaveLength(0);
  });
});
