import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import { account, applications, policyHeads, policyVersions, user } from '../private-db/schema.ts';
import { createEmptyPolicy, type Policy } from './policy.ts';
import { hashValue } from './stores.ts';
import { createPairing, pairWorker } from './pairing.ts';
import { createRun, enqueueApplication } from './runs.ts';
import { pollWorker } from './leases.ts';
import { beginSubmission, recordReceipt } from './submissions.ts';
import { getInbox } from './questions.ts';
import { listOutreach, recordOutreachDraft, sendOutreach, type OutreachOptions } from './outreach.ts';

vi.mock('server-only', () => ({}));
let db: PrivateDb, dir: string, now: number, options: OutreachOptions;
let sent: { from: string[]; to: string; subject: string; body: string }[];
const secret = () => randomBytes(32).toString('base64url');
const draft = (overrides: Partial<{ emails: string[]; domains: string[] }> = {}) => ({
  protocolVersion: 1 as const, subject: 'Following up on my Software Engineering Intern application',
  body: 'I just applied for the Software Engineering Intern role at Employer Co and wanted to reach out directly.',
  emails: [], domains: [], ...overrides,
});

async function application(ownerId = 'alice', submit = true, tenant = 'employer') {
  const grant = await createPairing(db, ownerId, { expectedRevision: 0, requestId: randomUUID(), label: 'Synthetic worker' }, options);
  const token = secret();
  const worker = await pairWorker(db, { protocolVersion: 1, workerId: randomUUID(), requestId: randomUUID(), grant: grant.grant,
    workerToken: token, workerVersion: '0.1.0', capabilities: ['control-v1'] }, options);
  const run = await createRun(db, ownerId, { expectedRevision: 0, requestId: randomUUID(), workerId: worker.workerId }, options);
  const app = await enqueueApplication(db, ownerId, run.id, { ats: 'fixture', tenant, requisition: randomUUID() }, options);
  const lease = (await pollWorker(db, token, { protocolVersion: 1 }, options)).lease!;
  if (!submit) return { token, app };
  await db.update(applications).set({ state: 'ready', checkpoint: { stage: 'ready', sequence: 0 } }).where(eq(applications.id, app.id));
  const intentId = randomUUID(), identity = { ats: app.ats, tenant: app.tenant, requisition: app.requisition };
  const role = { company: 'Employer Co', role: 'Software Engineering Intern' };
  await beginSubmission(db, token, app.id, { protocolVersion: 1, intentId, fence: lease.fence, expectedRevision: lease.revision,
    identity, ...role, manifestHash: 'a'.repeat(64), artifactHashes: ['b'.repeat(64)] }, options);
  await recordReceipt(db, token, app.id, { protocolVersion: 1, intentId, identity, ...role, receiptId: `receipt-${randomUUID().slice(0, 8)}`, submittedAt: now,
    evidence: { source: 'confirmation_page', pageUrl: 'https://job-boards.greenhouse.io/employer/jobs/1/confirmation', observedText: 'Thank you for applying.' } }, options);
  return { token, app };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'workie-outreach-'));
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('External network forbidden.'); }));
  now = 1_800_000_000_000;
  sent = [];
  options = { now: () => now, isAllowedApplicant: (email) => ['alice@example.test', 'bob@example.test'].includes(email),
    sender: (from) => async (message) => { sent.push({ from, ...message }); } };
  db = openPrivateDb({ url: `file:${join(dir, 'private.db')}` });
  await migratePrivateDb(db);
  for (const id of ['alice', 'bob']) {
    await db.insert(user).values({ id, name: 'Synthetic', email: `${id}@example.test`, emailVerified: true });
    await db.insert(account).values({ id: `${id}-credential`, userId: id, accountId: id, providerId: 'credential', password: secret() });
    const policy: Policy = { ...createEmptyPolicy(), actions: id === 'alice' ? ['email_recruiters'] : [] }, hash = hashValue(policy);
    await db.insert(policyVersions).values({ ownerId: id, version: 1, hash, policy, createdAt: now });
    await db.insert(policyHeads).values({ ownerId: id, revision: 1, policyVersion: 1, enabled: true,
      acceptedPolicyVersion: 1, acceptedPolicyHash: hash, acceptedAt: now });
  }
});
afterEach(() => {
  db?.$client.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
});

describe('recruiter email after a verified submission', () => {
  it('emails a recruiting address the posting names, exactly once, and notifies the inbox', async () => {
    const { token, app } = await application();
    const result = await recordOutreachDraft(db, token, app.id, draft({ emails: ['university-recruiting@employer.test'] }), options);
    expect(result).toMatchObject({ status: 'sent', to: 'university-recruiting@employer.test', source: 'posting', company: 'Employer Co', sentAt: now });
    expect(sent).toEqual([{ from: ['alice@example.test'], to: 'university-recruiting@employer.test',
      subject: draft().subject, body: `Hi there,\n\n${draft().body}` }]);
    // A retried worker call or a click on Send never emails twice.
    expect(await recordOutreachDraft(db, token, app.id, draft({ emails: ['other@employer.test'] }), options)).toMatchObject({ status: 'sent' });
    expect(await sendOutreach(db, 'alice', app.id, { to: 'x@employer.test', name: null }, options)).toMatchObject({ status: 'sent' });
    expect(sent).toHaveLength(1);
    expect((await getInbox(db, 'alice', {}, options)).items.map((item) => item.kind)).toContain('outreach');
  });

  it('finds a recruiter at the posting domain with Hunter, never by company name', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'hunter-test-key');
    const calls: { url: URL; key: string | null }[] = [];
    options.fetch = async (url, init) => {
      calls.push({ url: new URL(String(url)), key: new Headers(init?.headers).get('x-api-key') });
      return Response.json({ data: { emails: [
        { value: 'pat@employer.test', first_name: 'Pat', last_name: 'Lee', position: 'Head of Finance', confidence: 99 },
        { value: 'Jane.Doe@employer.test', first_name: 'Jane', last_name: 'Doe', position: 'Technical Recruiter', confidence: 91 },
      ] } });
    };
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options)).toMatchObject({
      status: 'sent', to: 'jane.doe@employer.test', name: 'Jane Doe', title: 'Technical Recruiter', source: 'hunter' });
    expect(sent[0].body.startsWith('Hi Jane,\n\n')).toBe(true);
    expect(calls[0].url.searchParams.get('domain')).toBe('employer.test');
    expect(calls[0].url.searchParams.has('company')).toBe(false);
    expect(calls[0].url.searchParams.has('api_key')).toBe(false);
    expect(calls[0].key).toBe('hunter-test-key');
  });

  it('keeps the draft when no recruiter is found, then sends to the address the applicant enters', async () => {
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null });
    expect(sent).toHaveLength(0);
    expect(await sendOutreach(db, 'alice', app.id, { to: 'Recruiter@Employer.test', name: 'Sam Park' }, options))
      .toMatchObject({ status: 'sent', to: 'recruiter@employer.test', source: 'manual' });
    expect(sent[0].body.startsWith('Hi Sam,\n\n')).toBe(true);
  });

  it('never emails the same recruiter twice automatically, and recovers from send and sender failures', async () => {
    const first = await application(), second = await application(), third = await application();
    const posting = draft({ emails: ['jobs@employer.test'] });
    await recordOutreachDraft(db, first.token, first.app.id, posting, options);
    expect(await recordOutreachDraft(db, second.token, second.app.id, posting, options))
      .toMatchObject({ status: 'skipped', reason: 'already_contacted', to: 'jobs@employer.test' });
    const failing: OutreachOptions = { ...options, sender: () => async () => { throw new Error('smtp down'); } };
    expect(await recordOutreachDraft(db, third.token, third.app.id, draft({ emails: ['campus@employer.test'] }), failing))
      .toMatchObject({ status: 'failed', reason: 'send_failed', to: 'campus@employer.test' });
    expect(await sendOutreach(db, 'alice', third.app.id, { to: 'campus@employer.test', name: null }, { ...options, sender: () => null }))
      .toMatchObject({ status: 'draft', reason: 'sender_not_configured' });
    expect(await sendOutreach(db, 'alice', third.app.id, { to: 'campus@employer.test', name: null }, options)).toMatchObject({ status: 'sent' });
    expect(sent.map((item) => item.to)).toEqual(['jobs@employer.test', 'campus@employer.test']);
  });

  it('requires the policy action and a verified submission, and stays private to its applicant', async () => {
    const bob = await application('bob');
    await expect(recordOutreachDraft(db, bob.token, bob.app.id, draft({ emails: ['jobs@employer.test'] }), options))
      .rejects.toMatchObject({ code: 'OUTREACH_DISABLED' });
    const pending = await application('alice', false, 'unsubmitted'); // an active lease holds its own tenant
    await expect(recordOutreachDraft(db, pending.token, pending.app.id, draft(), options)).rejects.toMatchObject({ status: 409 });
    const { token, app } = await application();
    await recordOutreachDraft(db, token, app.id, draft(), options);
    expect((await listOutreach(db, 'alice')).outreach.map((item) => item.applicationId)).toEqual([app.id]);
    expect((await listOutreach(db, 'bob')).outreach).toEqual([]);
    await expect(sendOutreach(db, 'bob', app.id, { to: 'x@employer.test', name: null }, options)).rejects.toMatchObject({ status: 404 });
    expect(sent).toHaveLength(0);
  });
});
