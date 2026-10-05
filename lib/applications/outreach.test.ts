import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openPrivateDb, migratePrivateDb, type PrivateDb } from '../private-db/index.ts';
import { account, applicationArtifacts, applications, documents, policyHeads, policyVersions, user } from '../private-db/schema.ts';
import { createEmptyPolicy, type Policy } from './policy.ts';
import { hashValue } from './stores.ts';
import { createPairing, pairWorker } from './pairing.ts';
import { createRun, enqueueApplication } from './runs.ts';
import { pollWorker } from './leases.ts';
import { beginSubmission, recordReceipt } from './submissions.ts';
import { getInbox } from './questions.ts';
import { listOutreach, recordOutreachDraft, sendDueOutreach, sendOutreach, sendWindow, type OutreachOptions } from './outreach.ts';
import { listMaterials, recordSubmittedLetter } from './materials.ts';
import { boardKey } from './company-domains.ts';
import { resolveApplicationIdentity } from './application-identity.ts';

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
    sender: (from) => async (message) => { sent.push({ from, ...message }); },
    resolveMx: async () => [{ exchange: 'mx.employer.test', priority: 10 }] };
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
  it('holds the draft for a recruiting address the posting names, sends it once the applicant presses Send, and notifies the inbox', async () => {
    const { token, app } = await application();
    const result = await recordOutreachDraft(db, token, app.id, draft({ emails: ['university-recruiting@employer.test'] }), options);
    expect(result).toMatchObject({ status: 'draft', reason: 'awaiting_approval', to: 'university-recruiting@employer.test', source: 'posting', company: 'Employer Co', sentAt: null });
    expect(sent).toHaveLength(0);
    expect(await sendOutreach(db, 'alice', app.id, { to: 'university-recruiting@employer.test', name: null }, options)).toMatchObject({ status: 'sent', sentAt: now });
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
      return Response.json({ data: { accept_all: true, emails: [
        { value: 'pat@employer.test', first_name: 'Pat', last_name: 'Lee', position: 'Head of Finance', confidence: 99 },
        { value: 'Jane.Doe@employer.test', first_name: 'Jane', last_name: 'Doe', position: 'Technical Recruiter', confidence: 91,
          verification: { status: 'valid' } },
      ] } });
    };
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options)).toMatchObject({
      status: 'draft', reason: 'awaiting_approval', to: 'jane.doe@employer.test', name: 'Jane Doe', title: 'Technical Recruiter', source: 'hunter' });
    expect(sent).toHaveLength(0);
    await sendOutreach(db, 'alice', app.id, { to: 'jane.doe@employer.test', name: 'Jane Doe' }, options);
    expect(sent[0].body.startsWith('Hi Jane,\n\n')).toBe(true);
    expect(calls[0].url.searchParams.get('domain')).toBe('employer.test');
    expect(calls[0].url.searchParams.has('company')).toBe(false);
    expect(calls[0].url.searchParams.has('api_key')).toBe(false);
    expect(calls[0].key).toBe('hunter-test-key');
  });

  it('looks up the registry domain of the board when the posting names none', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    const domains: string[] = [];
    options.fetch = async (url) => { const params = new URL(String(url)).searchParams;
      domains.push(`${params.get('type')}:${params.get('domain')}`);
      return Response.json({ data: { accept_all: false, emails: [] } }); };
    options.registryDomain = (ats, tenant) => (ats === 'fixture' && tenant === 'employer' ? 'employer.test' : null);
    const { token, app } = await application();
    await recordOutreachDraft(db, token, app.id, draft(), options);
    expect(domains[0]).toBe('personal:employer.test');
    domains.length = 0;
    const named = await application(); // the posting naming the same domain looks it up once
    await recordOutreachDraft(db, named.token, named.app.id, draft({ domains: ['employer.test'] }), options);
    expect(domains.filter((item) => item === 'personal:employer.test')).toHaveLength(1);
    // A Workday board is keyed by the host application-identity.ts takes as its tenant.
    const { identity } = resolveApplicationIdentity('https://nvidia.wd5.myworkdayjobs.com/NvidiaExternalCareerSite/job/US-CA-Santa-Clara/Intern_JR2001234', []);
    expect(boardKey({ ats: 'workday', token: 'nvidia', wdN: 'wd5' })).toBe(`${identity!.ats}:${identity!.tenant}`);
    expect(boardKey({ ats: 'greenhouse', token: 'airbnb' })).toBe('greenhouse:airbnb');
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

  it('never emails on its own or the same recruiter twice, and recovers from send and sender failures', async () => {
    const first = await application(), second = await application(), third = await application();
    const posting = draft({ emails: ['jobs@employer.test'] });
    await recordOutreachDraft(db, first.token, first.app.id, posting, options);
    await sendOutreach(db, 'alice', first.app.id, { to: 'jobs@employer.test', name: null }, options);
    expect(await recordOutreachDraft(db, second.token, second.app.id, posting, options))
      .toMatchObject({ status: 'skipped', reason: 'already_contacted', to: 'jobs@employer.test' });
    const failing: OutreachOptions = { ...options, sender: () => async () => { throw new Error('smtp down'); } };
    expect(await recordOutreachDraft(db, third.token, third.app.id, draft({ emails: ['campus@employer.test'] }), failing))
      .toMatchObject({ status: 'draft', reason: 'awaiting_approval', to: 'campus@employer.test' });
    expect(await sendOutreach(db, 'alice', third.app.id, { to: 'campus@employer.test', name: null }, failing))
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

  const hunter = (body: object, status = 200) => async () => Response.json(body, { status });
  const person = (extra: object) => ({ value: 'jane.doe@employer.test', first_name: 'Jane', last_name: 'Doe',
    position: 'University Recruiter', confidence: 80, sources: [{ uri: 'https://employer.test/team', still_on_page: true }], ...extra });

  it('skips a posting address whose domain takes no mail', async () => {
    const { token, app } = await application();
    const noMx: OutreachOptions = { ...options, resolveMx: async () => [] };
    expect(await recordOutreachDraft(db, token, app.id, draft({ emails: ['jobs@dead.test'] }), noMx))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null });
    expect(sent).toHaveLength(0);
  });

  it('sends to a Hunter recruiter only when verified, never on a catch-all guess', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    const catchAll = await application();
    options.fetch = hunter({ data: { accept_all: true, emails: [person({ confidence: 95 })] } });
    expect(await recordOutreachDraft(db, catchAll.token, catchAll.app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null });
    const verified = await application();
    options.fetch = hunter({ data: { accept_all: true, emails: [person({ verification: { status: 'valid' } })] } });
    expect(await recordOutreachDraft(db, verified.token, verified.app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'awaiting_approval', to: 'jane.doe@employer.test', source: 'hunter' });
  });

  it('falls back to Findymail, then a published generic inbox, and treats 451 as an opt-out', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    vi.stubEnv('WORKIE_FINDYMAIL_API_KEY', 'f');
    const calls: string[] = [];
    options.fetch = async (url) => {
      const u = new URL(String(url)); calls.push(`${u.hostname}${u.pathname}?type=${u.searchParams.get('type')}`);
      if (u.hostname === 'app.findymail.com') return Response.json({ contacts: [] });
      if (u.searchParams.get('type') === 'personal') return Response.json({}, { status: 451 });
      return Response.json({ data: { accept_all: false, emails: [
        { value: 'press@employer.test', position: null, confidence: 99, sources: [{ uri: 'https://employer.test' }] },
        { value: 'university@employer.test', position: null, confidence: 90, sources: [{ uri: 'https://employer.test/careers' }] },
      ] } });
    };
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'awaiting_approval', to: 'university@employer.test', source: 'hunter', name: null });
    expect(calls).toEqual(['api.hunter.io/v2/domain-search?type=personal', 'app.findymail.com/api/search/domain?type=null',
      'api.hunter.io/v2/domain-search?type=generic']);
  });

  it('takes a Findymail contact at the posting domain when Hunter finds no recruiter', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    vi.stubEnv('WORKIE_FINDYMAIL_API_KEY', 'f');
    options.fetch = async (url) => new URL(String(url)).hostname === 'app.findymail.com'
      ? Response.json({ contacts: [{ email: 'x@other.test' }, { email: 'ann@employer.test', name: 'Ann' }] })
      : Response.json({ data: { accept_all: false, emails: [] } });
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'awaiting_approval', to: 'ann@employer.test', source: 'findymail', name: 'Ann' });
  });

  it('schedules automatic sends for a Tue–Thu 16:00 UTC at least three days later', () => {
    const mon = Date.UTC(2026, 9, 5, 10); // Monday 2026-10-05 10:00 UTC
    expect(new Date(sendWindow(mon)).toISOString()).toBe('2026-10-08T16:00:00.000Z'); // Thursday
    const thu = Date.UTC(2026, 9, 8, 10);
    expect(new Date(sendWindow(thu)).toISOString()).toBe('2026-10-13T16:00:00.000Z'); // next Tuesday
    expect(new Date(sendWindow(Date.UTC(2026, 9, 2, 16, 0, 0, 1))).toISOString()).toBe('2026-10-06T16:00:00.000Z'); // a ms past 16:00 waits a day
  });

  it('holds the draft until its window, and the sweep still sends nothing the applicant has not approved', async () => {
    options.scheduled = true;
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ emails: ['jobs@employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'scheduled', to: null, sendAfter: sendWindow(now) });
    expect(sent).toHaveLength(0);
    expect(await sendDueOutreach(db, options)).toBe(0);
    now = sendWindow(now);
    expect(await sendDueOutreach(db, options)).toBe(0);
    expect(sent).toEqual([]);
  });

  it('lets the applicant send a scheduled draft right away', async () => {
    options.scheduled = true;
    const { token, app } = await application();
    await recordOutreachDraft(db, token, app.id, draft(), options);
    expect(await sendOutreach(db, 'alice', app.id, { to: 'pat@employer.test', name: 'Pat' }, options)).toMatchObject({ status: 'sent' });
  });

  it('leaves the recipient blank when every source comes up empty', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    options.fetch = hunter({ data: { accept_all: false, emails: [] } });
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null, name: null, source: null });
  });
});

describe('application materials', () => {
  it('keeps the submitted cover letter once and lists what the tailored resume changed, privately', async () => {
    const { token, app } = await application();
    const letter = { protocolVersion: 1 as const, introduction: 'I am applying for the Software Engineering Intern role.',
      body: ['I built TypeScript APIs.', 'I added CI checks.'], conclusion: 'Thank you.', companyParagraph: 'Employer Co builds tools.' };
    expect(await recordSubmittedLetter(db, token, app.id, letter, options)).toEqual({ applicationId: app.id, stored: true });
    await recordSubmittedLetter(db, token, app.id, { ...letter, conclusion: 'A replay cannot rewrite it.' }, options);
    const doc = (id: string, kind: 'resume_master' | 'resume_artifact') => ({ id, ownerId: 'alice', kind, name: 'resume.docx', masterId: id,
      version: 1, objectKey: `synthetic/${id}`, storage: 'local' as const, mime: 'application/pdf', size: 10, sha256: 'c'.repeat(64),
      state: 'available' as const, safetyCheck: 'passed' as const, createdAt: now });
    const master = randomUUID(), tailored = randomUUID();
    await db.insert(documents).values([doc(master, 'resume_master'), doc(tailored, 'resume_artifact')]);
    await db.insert(applicationArtifacts).values({ id: randomUUID(), ownerId: 'alice', applicationId: app.id, requestId: randomUUID(),
      sourceDocumentId: master, sourceVersion: 1, sourceHash: 'd'.repeat(64), documentId: tailored, outputHash: 'c'.repeat(64),
      manifestHash: 'e'.repeat(64), createdAt: now, manifest: { schemaVersion: 1, applicationId: app.id,
        source: { documentId: master, version: 1, sha256: 'd'.repeat(64) }, output: { sha256: 'c'.repeat(64), mime: 'application/pdf', size: 10 },
        template: { anchors: [{ id: 'line-1', text: 'Built REST APIs in TypeScript' }, { id: 'line-2', text: 'Skills: React' }] },
        request: { edits: [{ anchorId: 'line-1', replacement: 'Built TypeScript APIs with CI' }] },
        checks: { pageCount: 1, linksPreserved: true, frozenTextPreserved: true, anchorsFit: true }, tool: { name: 'workie-document-runtime', version: '1' } } });
    expect((await listMaterials(db, 'alice')).materials).toEqual([{ applicationId: app.id,
      resume: { documentId: tailored, mime: 'application/pdf', createdAt: now, changes: [{ before: 'Built REST APIs in TypeScript', after: 'Built TypeScript APIs with CI' }] },
      letter: { introduction: letter.introduction, body: letter.body, conclusion: 'Thank you.', companyParagraph: letter.companyParagraph } }]);
    expect((await listMaterials(db, 'bob')).materials).toEqual([]);
    const pending = await application('alice', false, 'unsubmitted');
    await expect(recordSubmittedLetter(db, pending.token, pending.app.id, letter, options)).rejects.toMatchObject({ status: 409 });
  });
});
