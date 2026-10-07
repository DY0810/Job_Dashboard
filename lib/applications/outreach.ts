import 'server-only';
import { Resolver } from 'node:dns/promises';
import { and, asc, eq, gt, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { PrivateDb } from '../private-db/index.ts';
import { applicationEvents, applicationReceipts, applications, user } from '../private-db/schema.ts';
import { accountFor, sendAll, type Outgoing } from '../send.ts';
import { artifactRequestId } from './artifact-protocol.ts';
import { registryDomain } from './company-domains.ts';
import { getPolicy, getProfile, hashValue } from './stores.ts';
import { appScope, fail, nowAt, withWorker, type WorkerOptions } from './worker-store.ts';
import { OutreachDraftSchema, OutreachSendSchema, type Outreach } from './worker-protocol.ts';

/**
 * One recruiter email per submitted application, kept in the application's immutable event log:
 * a draft, then numbered send attempts whose fixed event IDs let only one sender claim attempt N,
 * then an outcome per attempt or hold. Outcomes carry `kind`, so they reach the inbox. The applicant's Send records an
 * approval that queues the email for a Tue–Thu morning; the cron sends it, and Send now skips the queue.
 */
type Recipient = { to: string; name: string | null; title: string | null; source: 'posting' | 'hunter' | 'findymail' | 'manual' };
type Draft = { outreach: 'draft'; company: string; role: string; subject: string; body: string; emails: string[]; domains: string[];
  sendAfter?: number };
type Attempt = Recipient & { outreach: 'attempt'; attempt: number };
type Approval = Recipient & { outreach: 'approval'; sendAfter: number; auto?: true };
type Outcome = Partial<Recipient> & { kind: 'outreach'; outreach: 'outcome'; attempt: number | null;
  status: 'sent' | 'failed' | 'draft' | 'skipped'; reason: string | null };
type Entry = (Draft | Attempt | Approval | Outcome) & { createdAt: number };
type State = Omit<Outreach, 'contactedFor'> & { draft: Draft; attempts: number; autoApproved: boolean };
export type OutreachSender = (addresses: string[]) => ((message: Outgoing) => Promise<void>) | null;
export type OutreachOptions = WorkerOptions & { sender?: OutreachSender; fetch?: typeof fetch; resolveMx?: Resolver['resolveMx'];
  registryDomain?: typeof registryDomain };

const UNCONFIRMED_MS = 10 * 60_000, DAY = 86_400_000;
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
const GENERIC = /^(university|campus|early-?careers?|internships?|recruit(ing|ers?)?|talent|careers?|jobs)([._-]|$)/;
const HunterSchema = z.object({ data: z.object({ accept_all: z.boolean().nullable().optional(), emails: z.array(z.object({
  value: z.string(), first_name: z.string().nullable().optional(), last_name: z.string().nullable().optional(),
  position: z.string().nullable().optional(), confidence: z.number().nullable().optional(),
  verification: z.object({ status: z.string().nullable() }).nullable().optional(),
  sources: z.array(z.unknown()).optional(),
})) }) });
// app.findymail.com/docs "Find from domain": returns a contact only when its email is valid; at most 3 roles.
// ponytail: that endpoint is marked deprecated; its successor (search/employees) returns no email.
const FindymailSchema = z.object({ contacts: z.array(z.object({ email: z.string(), name: z.string().nullable().optional() })) });
const dns = new Resolver({ timeout: 2000, tries: 1 });
const isEmail = (value: string) => z.email().safeParse(value).success;

async function lookup(url: string, init: RequestInit, options: OutreachOptions) {
  try {
    const response = await (options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : null; // 451 = the person opted out; never retried
  } catch { return null; }
}
const hunter = (domain: string, type: 'personal' | 'generic', key: string, options: OutreachOptions) =>
  lookup(`https://api.hunter.io/v2/domain-search?${new URLSearchParams({ domain, type, limit: '10',
    ...(type === 'personal' ? { department: 'hr' } : {}) })}`, { headers: { 'X-API-KEY': key } }, options)
    .then((body) => HunterSchema.safeParse(body).data?.data ?? null);

/**
 * Verified sources only, cheapest and most accurate first; null leaves the recipient blank for the
 * applicant. Never a company-name lookup ("Sage" alone resolves to the wrong employer) and never a
 * guessed pattern: catch-all domains accept any address, so a guess cannot be verified.
 */
export async function findRecipient(draft: Pick<Draft, 'emails' | 'domains'>, options: OutreachOptions = {}): Promise<Recipient | null> {
  for (const email of draft.emails) {
    const mx = await (options.resolveMx ?? dns.resolveMx.bind(dns))(email.split('@')[1]).catch(() => []);
    if (mx.some((r) => r.exchange && r.exchange !== '.')) // RFC 7505 null MX takes no mail
      return { to: email, name: null, title: null, source: 'posting' };
  }
  const hunterKey = process.env.WORKIE_HUNTER_API_KEY?.trim(), findymailKey = process.env.WORKIE_FINDYMAIL_API_KEY?.trim();
  for (const domain of draft.domains.slice(0, 2)) {
    const people = hunterKey ? await hunter(domain, 'personal', hunterKey, options) : null;
    const best = people?.emails
      .filter((item) => RECRUITER.test(item.position ?? '') && isEmail(item.value) && item.value.toLowerCase().endsWith(`@${domain}`) &&
        (item.verification?.status === 'valid' || (people.accept_all === false && (item.confidence ?? 0) >= 90)))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    if (best) return { to: best.value.toLowerCase(), name: [best.first_name, best.last_name].filter(Boolean).join(' ') || null,
      title: best.position ?? null, source: 'hunter' };
    if (findymailKey) {
      const body = await lookup('https://app.findymail.com/api/search/domain', { method: 'POST',
        headers: { authorization: `Bearer ${findymailKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ domain, roles: ['University Recruiter', 'Technical Recruiter', 'Talent Acquisition'] }) }, options);
      const hit = FindymailSchema.safeParse(body).data?.contacts.find((item) => isEmail(item.email) && item.email.toLowerCase().endsWith(`@${domain}`));
      if (hit) return { to: hit.email.toLowerCase(), name: hit.name ?? null, title: null, source: 'findymail' };
    }
    const generic = hunterKey ? await hunter(domain, 'generic', hunterKey, options) : null;
    const inbox = generic?.emails.find((item) => isEmail(item.value) && item.value.toLowerCase().endsWith(`@${domain}`) &&
      GENERIC.test(item.value.split('@')[0].toLowerCase()) && (item.sources?.length ?? 0) > 0);
    if (inbox) return { to: inbox.value.toLowerCase(), name: null, title: null, source: 'hunter' };
  }
  return null;
}

/** The first Tue–Thu 16:00 UTC (9am Pacific in summer) at least `delay` after `after`. */
// ponytail: one fixed window for every employer; use the posting's location time zone if replies skew late.
export function sendWindow(after: number, delay = 3 * DAY) {
  const at = new Date(after + delay);
  at.setUTCHours(16, 0, 0, 0);
  if (at.getTime() < after + delay) at.setUTCDate(at.getUTCDate() + 1);
  while (![2, 3, 4].includes(at.getUTCDay())) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime();
}

/** Folds one application's log into its state: any send wins; otherwise the latest attempt or outcome. */
function fold(applicationId: string, log: Entry[], now: number): State | null {
  const draft = log.find((entry): entry is Draft & { createdAt: number } => entry.outreach === 'draft');
  if (!draft) return null;
  const moves = log.filter((entry): entry is (Attempt | Approval | Outcome) & { createdAt: number } => entry.outreach !== 'draft');
  const latest = moves.find((entry) => entry.outreach === 'outcome' && entry.status === 'sent') ?? moves.at(-1);
  const base = { applicationId, company: draft.company, role: draft.role, subject: draft.subject, body: draft.body,
    to: latest?.to ?? null, name: latest?.name ?? null, title: latest?.title ?? null, source: latest?.source ?? null,
    updatedAt: latest?.createdAt ?? draft.createdAt, sendAfter: latest?.outreach === 'approval' ? latest.sendAfter : draft.sendAfter ?? null, draft, attempts: moves.filter((entry) => entry.outreach === 'attempt').length,
    autoApproved: latest?.outreach === 'approval' && latest.auto === true };
  if (!latest) return { ...base, status: 'draft', reason: null, sentAt: null };
  if (latest.outreach === 'approval') return { ...base, status: 'draft', reason: 'scheduled', sentAt: null };
  if (latest.outreach === 'attempt') return now - latest.createdAt < UNCONFIRMED_MS
    ? { ...base, status: 'sending', reason: null, sentAt: null }
    // The process died mid-send: it may have gone out, so only the applicant may retry.
    : { ...base, status: 'failed', reason: 'send_unconfirmed', sentAt: null };
  return { ...base, status: latest.status, reason: latest.reason, sentAt: latest.status === 'sent' ? latest.createdAt : null };
}
function view(state: State, contactedFor: string | null = null): Outreach {
  const { applicationId, status, company, role, subject, body, to, name, title, source, reason, sentAt, sendAfter, updatedAt } = state;
  return { applicationId, status, company, role, subject, body, to, name, title, source, reason, sentAt, sendAfter, updatedAt, contactedFor };
}
const enabled = async (db: PrivateDb, ownerId: string, now: number) =>
  (await getPolicy(db, ownerId, now)).policy.actions.includes('email_recruiters');
/** Holds a queued email: recruiter email is off (Send again once it is back on), or automatic sending is off (press Send). */
async function holdDisabled(db: PrivateDb, ownerId: string, state: State, { to, name, title, source }: Recipient, now: number,
  reason = 'outreach_disabled') {
  await append(db, ownerId, state.applicationId, id(state.applicationId, 'hold', state.attempts, state.updatedAt, 'draft', reason, to),
    { kind: 'outreach', outreach: 'outcome', attempt: null, status: 'draft', reason, to, name, title, source }, now);
}

async function logs(db: PrivateDb, ownerId: string, applicationId?: string) {
  const rows = await db.select().from(applicationEvents).where(and(own(ownerId), ofOutreach,
    applicationId ? eq(applicationEvents.applicationId, applicationId) : undefined)).orderBy(asc(sql`rowid`));
  const byApplication = new Map<string, Entry[]>();
  for (const row of rows) byApplication.set(row.applicationId, [...byApplication.get(row.applicationId) ?? [],
    { ...row.acknowledgement as Draft | Attempt | Approval | Outcome, createdAt: row.createdAt }]);
  return byApplication;
}

async function append(db: PrivateDb, ownerId: string, applicationId: string, eventId: string, entry: Draft | Attempt | Approval | Outcome, now: number) {
  const inserted = await db.insert(applicationEvents).values({ ownerId, applicationId, eventId, requestHash: hashValue(entry),
    acknowledgement: entry, createdAt: now }).onConflictDoNothing().returning({ eventId: applicationEvents.eventId });
  return inserted.length > 0;
}

async function senderAddresses(db: PrivateDb, ownerId: string) {
  const [account] = await db.select({ email: user.email }).from(user).where(eq(user.id, ownerId));
  const personal = (await getProfile(db, ownerId)).profile.identity.personalEmail;
  return [account?.email, personal.state === 'confirmed' ? personal.value : null].filter((item): item is string => !!item);
}

const current = async (db: PrivateDb, ownerId: string, applicationId: string, options: OutreachOptions) =>
  fold(applicationId, (await logs(db, ownerId, applicationId)).get(applicationId) ?? [], nowAt(options));

/** `manual` is Send now; `queued` is the cron sending what the applicant approved; neither is the receipt's lookup, which only holds. */
async function deliver(db: PrivateDb, ownerId: string, applicationId: string, manual: Recipient | null, options: OutreachOptions,
  queued = false): Promise<Outreach> {
  const read = () => current(db, ownerId, applicationId, options);
  const state = await read();
  if (!state) fail(404, 'NOT_FOUND', 'No recruiter email draft for this application.');
  // Automatic delivery never retries a failure; the applicant does, from the Applications page.
  if (state.status === 'sent' || state.status === 'sending' || (!manual && state.status !== 'draft')) return view(state);
  // A retried receipt changes nothing once the draft has a hold or the applicant's approval.
  if (!manual && !queued && state.reason) return view(state);
  const settle = async (eventId: string, outcome: Omit<Outcome, 'kind' | 'outreach'>) => {
    await append(db, ownerId, applicationId, eventId, { kind: 'outreach', outreach: 'outcome', ...outcome }, nowAt(options));
    return view((await read())!);
  };
  const hold = (status: Outcome['status'], reason: string, recipient: Partial<Recipient> = {}) =>
    settle(id(applicationId, 'hold', state.attempts, state.updatedAt, status, reason, recipient.to ?? null), { attempt: null, status, reason, ...recipient });
  const recipient = manual ?? (state.to && state.source ? { to: state.to, name: state.name, title: state.title, source: state.source }
    : await findRecipient(state.draft, options));
  if (!manual && !queued) {
    // The lookup is slow: if the applicant pressed Send meanwhile, their approval stands.
    // ponytail: re-read, not a lock; a Send landing between this read and the hold's write is still lost.
    const latest = await read();
    if (latest!.reason || latest!.status !== 'draft') return view(latest!);
  }
  if (!recipient) return hold('draft', 'no_recipient');
  if (!manual) {
    const [earlier] = await db.select({ id: applicationEvents.eventId }).from(applicationEvents).where(and(own(ownerId),
      ne(applicationEvents.applicationId, applicationId),
      sql`json_extract(${applicationEvents.acknowledgement}, '$.outreach') = 'outcome'`,
      sql`json_extract(${applicationEvents.acknowledgement}, '$.status') = 'sent'`,
      sql`json_extract(${applicationEvents.acknowledgement}, '$.to') = ${recipient.to}`,
      // The applicant approved knowing of earlier sends; only one since then holds it.
      queued ? gt(applicationEvents.createdAt, state.updatedAt) : undefined)).limit(1);
    // A second role at the same employer never emails the same recruiter again on its own.
    if (earlier) return hold('skipped', 'already_contacted', recipient);
    // Nothing is emailed on the applicant's behalf until they review the draft and press Send, unless their
    // policy sends it for them; then it still waits for the draft's Tue–Thu window, and the cron sends it.
    if (!queued) {
      const live = await getPolicy(db, ownerId, nowAt(options));
      // Like submit (runs.ts), only an enabled policy acts without a click.
      if (!live.enabled || !live.policy.actions.includes('auto_send_recruiter_email')) {
        return hold('draft', 'awaiting_approval', recipient);
      }
      await append(db, ownerId, applicationId, id(applicationId, 'approval', state.attempts, state.updatedAt, recipient.to),
        { outreach: 'approval', ...recipient, sendAfter: state.draft.sendAfter ?? sendWindow(nowAt(options), 0), auto: true }, nowAt(options));
      return view((await read())!);
    }
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

/** Worker call after a verified receipt: stores the draft once and finds a recipient; the applicant sends it. */
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
    // The board's curated domain leads: postings rarely name one, and a company name never stands in for it.
    const curated = (options.registryDomain ?? registryDomain)(app.ats, app.tenant);
    const entry: Draft = { outreach: 'draft', company: receipt.company, role: receipt.role, subject: draft.subject,
      body: draft.body, emails: draft.emails, domains: [...new Set([...(curated ? [curated] : []), ...draft.domains])].slice(0, 5),
      sendAfter: sendWindow(receipt.submittedAt) }; // never on application day
    await tx.insert(applicationEvents).values({ ownerId: worker.ownerId, applicationId, eventId: id(applicationId, 'draft'),
      requestHash: hashValue(entry), acknowledgement: entry, createdAt: now }).onConflictDoNothing();
    return worker.ownerId;
  });
  return deliver(db, ownerId, applicationId, null, options);
}

/** Cron: sends each approved email whose queue time has come, once; a hold or failure here is never retried. */
// ponytail: unindexed json_extract scan of application_events; add an expression index if the table outgrows a full scan.
export async function sendDueOutreach(db: PrivateDb, options: OutreachOptions = {}) {
  const now = nowAt(options);
  // Only approvals nothing has followed yet: a sent, failed, held or superseded one is settled, and the fold still decides.
  const rows = await db.selectDistinct({ ownerId: applicationEvents.ownerId, applicationId: applicationEvents.applicationId })
    .from(applicationEvents).where(and(sql`json_extract(${applicationEvents.acknowledgement}, '$.outreach') = 'approval'`,
      sql`json_extract(${applicationEvents.acknowledgement}, '$.sendAfter') <= ${now}`,
      sql`not exists (select 1 from private_application_event later where later.owner_id = ${applicationEvents.ownerId}
        and later.application_id = ${applicationEvents.applicationId} and later.rowid > ${applicationEvents}.rowid
        and json_extract(later.acknowledgement, '$.outreach') is not null)`));
  let sent = 0;
  for (const { ownerId, applicationId } of rows) {
    try {
      const state = await current(db, ownerId, applicationId, options);
      if (state?.reason !== 'scheduled' || (state.sendAfter ?? Infinity) > now) continue; // still queued, and due
      // The applicant may have turned recruiter email off since approving it: hold it rather than send it weeks later.
      const { enabled: active, policy: { actions } } = await getPolicy(db, ownerId, now);
      const recipient: Recipient = { to: state.to!, name: state.name, title: state.title, source: state.source! };
      if (!actions.includes('email_recruiters')) { await holdDisabled(db, ownerId, state, recipient, now); continue; }
      // The policy queued it and automatic sending is off or the policy is disabled now: it waits for Send again.
      if (state.autoApproved && !(active && actions.includes('auto_send_recruiter_email'))) {
        await holdDisabled(db, ownerId, state, recipient, now, 'awaiting_approval');
        continue;
      }
      if ((await deliver(db, ownerId, applicationId, null, options, true)).status === 'sent') sent += 1;
    } catch (error) { console.error('outreach sweep', applicationId, error); } // one bad row never stops the rest
  }
  return sent;
}

/** The applicant's Send: queues the email for the next window (or the draft's own, if later); Send now sends at once. */
export async function sendOutreach(db: PrivateDb, ownerId: string, applicationId: string, input: unknown, options: OutreachOptions = {}) {
  const { to, name, now: immediately } = OutreachSendSchema.parse(input);
  const state = await current(db, ownerId, applicationId, options);
  if (!state) fail(404, 'NOT_FOUND', 'No recruiter email draft for this application.');
  // Keep the found recruiter's title and source when the applicant sends to that same address.
  const recipient: Recipient = to === state.to && state.source ? { to, name, title: state.title, source: state.source }
    : { to, name, title: null, source: 'manual' };
  if (state.status === 'sent' || state.status === 'sending') return view(state);
  if (!await enabled(db, ownerId, nowAt(options))) {
    await holdDisabled(db, ownerId, state, recipient, nowAt(options));
    return view((await current(db, ownerId, applicationId, options))!);
  }
  if (immediately) return deliver(db, ownerId, applicationId, recipient, options);
  const sendAfter = Math.max(state.draft.sendAfter ?? 0, sendWindow(nowAt(options), 0));
  await append(db, ownerId, applicationId, id(applicationId, 'approval', state.attempts, state.updatedAt, to), { outreach: 'approval', ...recipient, sendAfter }, nowAt(options));
  return view((await current(db, ownerId, applicationId, options))!);
}

export async function listOutreach(db: PrivateDb, ownerId: string, options: WorkerOptions = {}) {
  const states = [...await logs(db, ownerId)].flatMap(([applicationId, log]) => fold(applicationId, log, nowAt(options)) ?? []);
  // Each address's first send, so the applicant knows before emailing that recruiter about another role.
  const sentTo = new Map<string, State>();
  for (const state of states) if (state.status === 'sent' && state.to && !sentTo.has(state.to)) sentTo.set(state.to, state);
  return { ownerId, outreach: states.map((state) => {
    const earlier = state.to ? sentTo.get(state.to) : undefined;
    return view(state, earlier && earlier.applicationId !== state.applicationId ? `${earlier.company} – ${earlier.role}` : null);
  }) };
}
