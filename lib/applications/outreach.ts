import 'server-only';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationEvents, applicationReceipts, applications, user } from '../private-db/schema.ts';
import { accountFor, sendAll, type Outgoing } from '../send.ts';
import { artifactRequestId } from './artifact-protocol.ts';
import { getPolicy, getProfile, hashValue } from './stores.ts';
import { appScope, fail, nowAt, withWorker, type WorkerOptions } from './worker-store.ts';
import { OutreachDraftSchema, OutreachSendSchema, type Outreach } from './worker-protocol.ts';

/**
 * One recruiter email per submitted application, kept in the application's immutable event log:
 * a draft, then numbered send attempts whose fixed event IDs let only one sender claim attempt N,
 * then an outcome per attempt or hold. Outcomes carry `kind`, so they reach the inbox.
 */
type Recipient = { to: string; name: string | null; title: string | null; source: 'posting' | 'hunter' | 'manual' };
type Draft = { outreach: 'draft'; company: string; role: string; subject: string; body: string; emails: string[]; domains: string[] };
type Attempt = Recipient & { outreach: 'attempt'; attempt: number };
type Outcome = Partial<Recipient> & { kind: 'outreach'; outreach: 'outcome'; attempt: number | null;
  status: 'sent' | 'failed' | 'draft' | 'skipped'; reason: string | null };
type Entry = (Draft | Attempt | Outcome) & { createdAt: number };
type State = Outreach & { draft: Draft; attempts: number };
export type OutreachSender = (addresses: string[]) => ((message: Outgoing) => Promise<void>) | null;
export type OutreachOptions = WorkerOptions & { sender?: OutreachSender; fetch?: typeof fetch };

const UNCONFIRMED_MS = 10 * 60_000;
const id = (applicationId: string, ...part: unknown[]) => artifactRequestId({ outreach: applicationId, part });
const own = (ownerId: string) => eq(applicationEvents.ownerId, ownerId);
const ofOutreach = sql`json_extract(${applicationEvents.acknowledgement}, '$.outreach') is not null`;

/** Sends only from a configured Gmail account whose address is the applicant's own. */
const smtpSender: OutreachSender = (addresses) => {
  const account = addresses.map((address) => accountFor(address)).find((item) => item !== null);
  return account ? async (message) => {
    const result = await sendAll(account, [message]);
    if (result.sent !== 1) throw new Error(result.failed[0]?.reason ?? 'send failed');
  } : null;
};

const RECRUITER = /recruit|talent|university|campus|early career|intern/i;
const HunterSchema = z.object({ data: z.object({ emails: z.array(z.object({
  value: z.string(), first_name: z.string().nullable().optional(), last_name: z.string().nullable().optional(),
  position: z.string().nullable().optional(), confidence: z.number().nullable().optional(),
})) }) });

/**
 * A recruiting address the posting itself names, else Hunter's HR people at a domain the posting
 * names. A company-name lookup is never used: "Sage" alone resolves to the wrong employer.
 */
export async function findRecipient(draft: Pick<Draft, 'emails' | 'domains'>, options: OutreachOptions = {}): Promise<Recipient | null> {
  if (draft.emails[0]) return { to: draft.emails[0], name: null, title: null, source: 'posting' };
  const key = process.env.WORKIE_HUNTER_API_KEY?.trim();
  if (!key) return null;
  for (const domain of draft.domains.slice(0, 2)) {
    try {
      const response = await (options.fetch ?? fetch)(`https://api.hunter.io/v2/domain-search?${new URLSearchParams({
        domain, department: 'hr', type: 'personal', limit: '10' })}`,
      { headers: { 'X-API-KEY': key }, redirect: 'error', signal: AbortSignal.timeout(5000) });
      const parsed = response.ok ? HunterSchema.safeParse(await response.json()) : null;
      const best = parsed?.success ? parsed.data.data.emails
        .filter((item) => RECRUITER.test(item.position ?? '') && z.email().safeParse(item.value).success)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0] : undefined;
      if (best) return { to: best.value.toLowerCase(), name: [best.first_name, best.last_name].filter(Boolean).join(' ') || null,
        title: best.position ?? null, source: 'hunter' };
    } catch { /* an unreachable lookup leaves the draft for the applicant */ }
  }
  return null;
}

/** Folds one application's log into its state: any send wins; otherwise the latest attempt or outcome. */
function fold(applicationId: string, log: Entry[], now: number): State | null {
  const draft = log.find((entry): entry is Draft & { createdAt: number } => entry.outreach === 'draft');
  if (!draft) return null;
  const moves = log.filter((entry): entry is (Attempt | Outcome) & { createdAt: number } => entry.outreach !== 'draft');
  const latest = moves.find((entry) => entry.outreach === 'outcome' && entry.status === 'sent') ?? moves.at(-1);
  const base = { applicationId, company: draft.company, role: draft.role, subject: draft.subject, body: draft.body,
    to: latest?.to ?? null, name: latest?.name ?? null, title: latest?.title ?? null, source: latest?.source ?? null,
    updatedAt: latest?.createdAt ?? draft.createdAt, draft, attempts: moves.filter((entry) => entry.outreach === 'attempt').length };
  if (!latest) return { ...base, status: 'draft', reason: null, sentAt: null };
  if (latest.outreach === 'attempt') return now - latest.createdAt < UNCONFIRMED_MS
    ? { ...base, status: 'sending', reason: null, sentAt: null }
    // The process died mid-send: it may have gone out, so only the applicant may retry.
    : { ...base, status: 'failed', reason: 'send_unconfirmed', sentAt: null };
  return { ...base, status: latest.status, reason: latest.reason, sentAt: latest.status === 'sent' ? latest.createdAt : null };
}
function view(state: State): Outreach {
  const { applicationId, status, company, role, subject, body, to, name, title, source, reason, sentAt, updatedAt } = state;
  return { applicationId, status, company, role, subject, body, to, name, title, source, reason, sentAt, updatedAt };
}

async function logs(db: PrivateDb, ownerId: string, applicationId?: string) {
  const rows = await db.select().from(applicationEvents).where(and(own(ownerId), ofOutreach,
    applicationId ? eq(applicationEvents.applicationId, applicationId) : undefined)).orderBy(asc(sql`rowid`));
  const byApplication = new Map<string, Entry[]>();
  for (const row of rows) byApplication.set(row.applicationId, [...byApplication.get(row.applicationId) ?? [],
    { ...row.acknowledgement as Draft | Attempt | Outcome, createdAt: row.createdAt }]);
  return byApplication;
}

async function append(db: PrivateDb, ownerId: string, applicationId: string, eventId: string, entry: Draft | Attempt | Outcome, now: number) {
  const inserted = await db.insert(applicationEvents).values({ ownerId, applicationId, eventId, requestHash: hashValue(entry),
    acknowledgement: entry, createdAt: now }).onConflictDoNothing().returning({ eventId: applicationEvents.eventId });
  return inserted.length > 0;
}

async function senderAddresses(db: PrivateDb, ownerId: string) {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, ownerId));
  const personal = (await getProfile(db, ownerId)).profile.identity.personalEmail;
  return [account?.email, personal.state === 'confirmed' ? personal.value : null].filter((item): item is string => !!item);
}

async function deliver(db: PrivateDb, ownerId: string, applicationId: string, manual: Recipient | null, options: OutreachOptions): Promise<Outreach> {
  const read = async () => fold(applicationId, (await logs(db, ownerId, applicationId)).get(applicationId) ?? [], nowAt(options));
  const state = await read();
  if (!state) fail(404, 'NOT_FOUND', 'No recruiter email draft for this application.');
  // Automatic delivery never retries a failure; the applicant does, from the Applications page.
  if (state.status === 'sent' || state.status === 'sending' || (!manual && state.status !== 'draft')) return view(state);
  const settle = async (eventId: string, outcome: Omit<Outcome, 'kind' | 'outreach'>) => {
    await append(db, ownerId, applicationId, eventId, { kind: 'outreach', outreach: 'outcome', ...outcome }, nowAt(options));
    return view((await read())!);
  };
  const hold = (status: Outcome['status'], reason: string, recipient: Partial<Recipient> = {}) =>
    settle(id(applicationId, 'hold', state.attempts, status, reason, recipient.to ?? null), { attempt: null, status, reason, ...recipient });
  const recipient = manual ?? (state.to && state.source ? { to: state.to, name: state.name, title: state.title, source: state.source }
    : await findRecipient(state.draft, options));
  if (!recipient) return hold('draft', 'no_recipient');
  if (!manual) {
    const [earlier] = await db.select({ id: applicationEvents.eventId }).from(applicationEvents).where(and(own(ownerId),
      ne(applicationEvents.applicationId, applicationId),
      sql`json_extract(${applicationEvents.acknowledgement}, '$.outreach') = 'outcome'`,
      sql`json_extract(${applicationEvents.acknowledgement}, '$.status') = 'sent'`,
      sql`json_extract(${applicationEvents.acknowledgement}, '$.to') = ${recipient.to}`)).limit(1);
    // A second role at the same employer never emails the same recruiter again on its own.
    if (earlier) return hold('skipped', 'already_contacted', recipient);
  }
  const send = (options.sender ?? smtpSender)(await senderAddresses(db, ownerId));
  if (!send) return hold('draft', 'sender_not_configured', recipient);
  const attempt = state.attempts + 1;
  if (!await append(db, ownerId, applicationId, id(applicationId, 'attempt', attempt), { outreach: 'attempt', attempt, ...recipient }, nowAt(options))) {
    return view((await read())!); // another request claimed this attempt first
  }
  let outcome: Pick<Outcome, 'status' | 'reason'> = { status: 'sent', reason: null };
  try {
    await send({ to: recipient.to, subject: state.subject, body: `Hi ${recipient.name?.split(' ')[0] ?? 'there'},\n\n${state.body}` });
  } catch { outcome = { status: 'failed', reason: 'send_failed' }; }
  return settle(id(applicationId, 'outcome', attempt), { attempt, ...outcome, ...recipient });
}

/** Worker call after a verified receipt: stores the draft once, then sends when a recipient is found. */
export async function recordOutreachDraft(db: PrivateDb, token: string, applicationId: string, input: unknown, options: OutreachOptions = {}) {
  const draft = OutreachDraftSchema.parse(input);
  const ownerId = await withWorker(db, token, options, async (tx, worker, now) => {
    const [app] = await tx.select().from(applications).where(and(appScope(worker.ownerId, applicationId), eq(applications.workerId, worker.id)));
    const [receipt] = await tx.select().from(applicationReceipts).where(and(
      eq(applicationReceipts.ownerId, worker.ownerId), eq(applicationReceipts.applicationId, applicationId)));
    if (!app || app.state !== 'submitted' || !receipt) fail(409, 'CONFLICT', 'Recruiter email follows a verified submission.');
    if (!(await getPolicy(tx, worker.ownerId, now)).policy.actions.includes('email_recruiters')) {
      fail(403, 'OUTREACH_DISABLED', 'Recruiter email is not enabled in the policy.');
    }
    const entry: Draft = { outreach: 'draft', company: receipt.company, role: receipt.role, subject: draft.subject,
      body: draft.body, emails: draft.emails, domains: draft.domains };
    await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId, eventId: id(applicationId, 'draft'),
      requestHash: hashValue(entry), acknowledgement: entry, createdAt: now }).onConflictDoNothing();
    return worker.ownerId;
  });
  return deliver(db, ownerId, applicationId, null, options);
}

/** The applicant's own send, to an address they chose. */
export async function sendOutreach(db: PrivateDb, ownerId: string, applicationId: string, input: unknown, options: OutreachOptions = {}) {
  const { to, name } = OutreachSendSchema.parse(input);
  return deliver(db, ownerId, applicationId, { to, name, title: null, source: 'manual' }, options);
}

export async function listOutreach(db: PrivateDb, ownerId: string, options: WorkerOptions = {}) {
  return { ownerId, outreach: [...await logs(db, ownerId)].flatMap(([applicationId, log]) => {
    const state = fold(applicationId, log, nowAt(options));
    return state ? [view(state)] : [];
  }) };
}
