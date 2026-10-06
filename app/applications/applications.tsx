'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition';
import { HEARTBEAT_MS, MaterialsSchema, OutreachListSchema, RunListSchema, WorkerListSchema, type Outreach, type Run } from '../../lib/applications/worker-protocol';
import { PolicySchema } from '../../lib/applications/policy';
import { isAwaitingSubmitApproval, isSafeRetryState } from '../../lib/applications/state';
import styles from '../workers/workers.module.css';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const PolicyResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.boolean(),
});
const label = (value: string) => value.replaceAll('_', ' ');
const short = (value: string) => value.slice(0, 8);

type View = {
  account: z.infer<typeof ApplicantSchema> | null;
  workers: z.infer<typeof WorkerListSchema> | null;
  runs: z.infer<typeof RunListSchema> | null;
  policy: z.infer<typeof PolicyResponseSchema> | null;
  outreach: Outreach[];
  materials: Material[];
  loading: boolean;
  locked: boolean;
  error: string;
};

type Material = z.infer<typeof MaterialsSchema>['materials'][number];
const initialView: View = { account: null, workers: null, runs: null, policy: null, outreach: [], materials: [], loading: true, locked: true, error: '' };

async function request(path: string, ownerId?: string) {
  const headers = new Headers();
  if (ownerId) headers.set(EXPECTED_APPLICANT_HEADER, ownerId);
  const response = await fetch(path, {
    headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? 'Unlock Workie to view private applications.' :
    response.status === 403 ? 'Applicant access denied.' : 'Private application status is unavailable.');
  return body;
}

/** The tailored resume (and the lines it changed) and the cover letter for this application, before or after it is submitted. */
function MaterialsPanel({ item }: { item: Material }) {
  const { resume, letter } = item;
  return <>
    {resume && <div>
      <div className={styles.row}>
        <span>Tailored resume: {resume.changes.length ? `${resume.changes.length} line${resume.changes.length === 1 ? '' : 's'} rewritten for this posting` : 'saved'}</span>
        <a href={`/api/documents/${resume.documentId}/download`} download>Download</a>
      </div>
      {resume.changes.length > 0 && <details><summary className={styles.muted}>What changed</summary>
        <ul className={styles.changes}>{resume.changes.map((change, index) =>
          <li key={index}><del>{change.before}</del><ins>{change.after}</ins></li>)}</ul>
      </details>}
    </div>}
    {letter && <details><summary className={styles.muted}>Cover letter</summary>
      <pre className={styles.preview}>{['Dear Hiring Manager,', letter.introduction, ...letter.body, letter.conclusion, letter.companyParagraph].join('\n\n')}</pre>
    </details>}
  </>;
}

function outreachStatus(item: Outreach) {
  const who = `${item.name ?? item.to}${item.title ? ` (${item.title})` : ''}`;
  if (item.status === 'sent') return `Emailed ${who}${item.sentAt ? ` on ${new Date(item.sentAt).toLocaleDateString()}` : ''}`;
  if (item.status === 'sending') return `Sending to ${who}...`;
  const earlier = item.contactedFor ? ` Already emailed about ${item.contactedFor}.` : '';
  if (item.status === 'skipped') return `Not sent: ${who} was already emailed about ${item.contactedFor ?? 'another role'}`;
  if (item.status === 'failed') return `Sending to ${who} failed. Check the address and send again.`;
  const when = (at: number | null) => at && at > Date.now() ? new Date(at).toLocaleString() : 'the next Tue–Thu morning';
  if (item.reason === 'scheduled') return `Queued for ${who} on ${when(item.sendAfter)}. Send now to skip the wait.${earlier}`;
  if (item.reason === 'outreach_disabled') return `Not sent to ${who}: recruiter email is off in the Auto Apply policy. Turn it on and press Send again.`;
  if (item.reason === 'awaiting_approval') return `Draft ready for ${who}. Send queues it for ${when(item.sendAfter)}; nothing goes out until you press it.${earlier}`;
  return item.reason === 'sender_not_configured' ? `Ready for ${who}, but Gmail sending is not set up for your address`
    : 'Draft ready. No recruiter address was found; add one to send.';
}

/** A filled form waits here until the applicant has reviewed its resume and letter. */
function ApprovePanel({ app, ownerId, onChange }: { app: { id: string; runId: string; revision: number }; ownerId: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const approve = async () => {
    if (!window.confirm('Submit this application to the employer now? This cannot be undone.')) return;
    setBusy(true); setError('');
    try {
      const response = await fetch(`/api/application-runs/${app.runId}/applications/${app.id}/actions`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json', [EXPECTED_APPLICANT_HEADER]: ownerId },
        body: JSON.stringify({ action: 'approve-submit', requestId: crypto.randomUUID(), expectedRevision: app.revision }),
      });
      if (!response.ok) throw new Error(response.status === 403 ? 'Turn on Submit in the Auto Apply policy first.' : 'Could not approve. Refresh and try again.');
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not approve.'); }
    finally { setBusy(false); }
  };
  return <div className={styles.row}>
    <span>Form filled. Review the resume and cover letter, then approve to submit.</span>
    <button className={styles.button} type="button" disabled={busy} onClick={() => void approve()}>{busy ? 'Approving...' : 'Approve and submit'}</button>
    {error && <span role="alert" className={styles.reason}>{error}</span>}
  </div>;
}

const documentHelp: Record<string, string> = {
  transcript_unavailable: 'The form requires a transcript. Add it to your profile and allow transcripts in the Auto Apply policy, then retry.',
  required_document_unavailable: 'The form requires an upload Workie has no document for (often a transcript). Add it to your profile and allow its kind in the Auto Apply policy, then retry.',
  resume_required: 'Add a resume to your profile, then retry.',
  cover_letter_unavailable: 'The form asks for a cover letter. Allow cover letters in the Auto Apply policy, then retry.',
};

/** A document hold the applicant has fixed resumes here, in its own run or, after a policy change, in the newest running run. */
function RetryPanel({ app, runs, ownerId, onChange }: { app: { id: string; runId: string; revision: number; reasonCode: string | null }; runs: Run[]; ownerId: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const post = (path: string, body: object) => fetch(path, {
    method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'content-type': 'application/json', [EXPECTED_APPLICANT_HEADER]: ownerId },
    body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: app.revision, ...body }),
  });
  const retry = async () => {
    setBusy(true); setError('');
    try {
      let response = await post(`/api/application-runs/${app.runId}/applications/${app.id}/actions`, { action: 'retry-safe' });
      if (response.status === 409 && (await response.clone().json().catch(() => null))?.code === 'POLICY_CHANGED') {
        const next = runs.find((run) => run.state === 'running' && run.id !== app.runId);
        if (!next) throw new Error('The Auto Apply policy changed after this run started. Start a new run from Workers, then retry.');
        response = await post(`/api/application-runs/${next.id}/retry-unsubmitted`, { previousApplicationId: app.id });
        if (response.status === 409 && (await response.json().catch(() => null))?.code === 'DISCOVERY_REQUIRED') {
          throw new Error('The new run has not found this role yet. Retry after its discovery finishes.');
        }
      }
      if (!response.ok) throw new Error('Could not retry. Refresh and try again.');
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not retry.'); }
    finally { setBusy(false); }
  };
  return <div className={styles.row}>
    <span>{documentHelp[app.reasonCode ?? ''] ?? 'Fix the missing document, then retry.'}</span>
    <button className={styles.button} type="button" disabled={busy} onClick={() => void retry()}>{busy ? 'Retrying...' : 'Retry'}</button>
    {error && <span role="alert" className={styles.reason}>{error}</span>}
  </div>;
}

function OutreachPanel({ item, ownerId, onChange }: { item: Outreach; ownerId: string; onChange: () => void }) {
  const [to, setTo] = useState(item.to ?? '');
  const [busy, setBusy] = useState<'queue' | 'now' | null>(null);
  const [error, setError] = useState('');
  const send = async (now: boolean) => {
    setBusy(now ? 'now' : 'queue'); setError('');
    try {
      const response = await fetch(`/api/outreach/${item.applicationId}`, {
        method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(60_000),
        headers: { 'content-type': 'application/json', [EXPECTED_APPLICANT_HEADER]: ownerId },
        body: JSON.stringify({ to: to.trim(), name: to.trim() === item.to ? item.name : null, now }),
      });
      if (!response.ok) throw new Error();
      onChange();
    } catch { setError(`Could not ${now ? 'send' : 'queue'}. Check the address and try again.`); }
    finally { setBusy(null); }
  };
  return <div>
    <div className={styles.row}><span>Recruiter email: {outreachStatus(item)}</span></div>
    <details><summary className={styles.muted}>{item.subject}</summary><pre className={styles.preview}>{item.body}</pre></details>
    {item.status !== 'sent' && item.status !== 'sending' && <form className={styles.form} onSubmit={(event) => {
      event.preventDefault(); void send((event.nativeEvent as SubmitEvent).submitter?.getAttribute('name') === 'now'); }}>
      <input type="email" required value={to} onChange={(event) => setTo(event.target.value)} placeholder="recruiter@company.com" aria-label={`Recruiter email for ${item.company}`} />
      <button className={styles.button} type="submit" disabled={!!busy}>{busy === 'queue' ? 'Queueing...' : 'Send'}</button>
      <button className={styles.button} type="submit" name="now" disabled={!!busy}>{busy === 'now' ? 'Sending...' : 'Send now'}</button>
      {error && <span role="alert" className={styles.reason}>{error}</span>}
    </form>}
  </div>;
}

export default function Applications() {
  const [view, setView] = useState(initialView);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setView((current) => ({ ...current, loading: true, locked: true, error: '' }));
    else setRefreshing(true);
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant'));
      const [workers, runs, policy, outreach, materials] = await Promise.all([
        WorkerListSchema.parse(await request('/api/workers', account.ownerId)),
        RunListSchema.parse(await request('/api/application-runs', account.ownerId)),
        PolicyResponseSchema.parse(await request('/api/auto-apply/policies', account.ownerId)),
        // Recruiter email is secondary: its failure must not hide the application history.
        request('/api/outreach', account.ownerId).then((body) => OutreachListSchema.parse(body)).catch(() => null),
        request('/api/applications/materials', account.ownerId).then((body) => MaterialsSchema.parse(body)).catch(() => null),
      ]);
      if (workers.ownerId !== account.ownerId || runs.ownerId !== account.ownerId ||
          (outreach && outreach.ownerId !== account.ownerId) || (materials && materials.ownerId !== account.ownerId)) {
        throw new Error('Account changed. Refresh the current applicant.');
      }
      setView({ account, workers, runs, policy, outreach: outreach?.outreach ?? [], materials: materials?.materials ?? [],
        loading: false, locked: false, error: '' });
    } catch (error) {
      setView((current) => ({ ...current, loading: false, locked: true,
        error: error instanceof z.ZodError ? 'Private service returned an incompatible response.' :
          error instanceof Error ? error.message : 'Private application status is unavailable.' }));
    } finally { setRefreshing(false); }
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void load(true); }, HEARTBEAT_MS * 3);
    const focus = () => { if (document.visibilityState === 'visible') void load(true); };
    window.addEventListener('focus', focus);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); };
  }, [load]);

  const applications = view.runs?.applications ?? [];
  const counts = applications.reduce<Record<string, number>>((result, app) => {
    result[app.state] = (result[app.state] ?? 0) + 1;
    return result;
  }, {});
  const onlineWorkers = view.workers?.workers.filter((worker) => worker.online) ?? [];
  const outreach = new Map(view.outreach.map((item) => [item.applicationId, item]));
  const materials = new Map(view.materials.map((item) => [item.applicationId, item]));
  return <>
    <div className={styles.toolbar}>
      <h1>Applications</h1>
      {!view.locked && <span className={styles.muted}>{view.account?.email}</span>}
      <button className={styles.button} type="button" disabled={view.loading || refreshing} onClick={() => void load()}>
        {refreshing ? 'Refreshing...' : 'Refresh'}
      </button>
    </div>
    {view.error && <p role="alert" className={styles.message}>{view.error}</p>}
    {view.locked && !view.loading && <p className={styles.row}>
      <span>Applications are private to the signed-in applicant.</span>
      <Link href="/sign-in" prefetch={false}>Sign in</Link>
    </p>}
    {!view.locked && <>
      <section className={styles.section} aria-labelledby="status-heading">
        <h2 id="status-heading">Execution status</h2>
        <div className={styles.row}>
          <span>{onlineWorkers.length ? `${onlineWorkers.length} worker${onlineWorkers.length === 1 ? '' : 's'} online` : 'No worker online'}</span>
          <span>{view.policy?.enabled ? 'Policy enabled' : 'Policy disabled'}</span>
          <span>{view.policy?.enabled && view.policy.runnerAvailable ? 'Execution available' : 'Waiting for worker'}</span>
        </div>
        <p className={styles.muted}>The provider key is checked by the paired local worker when a run needs it; this page does not read or expose credentials.</p>
      </section>
      <section className={styles.section} aria-labelledby="counts-heading">
        <div className={styles.row}><h2 id="counts-heading">Current queue</h2><Link href="/workers" prefetch={false}>Manage workers and runs</Link></div>
        <div className={styles.row} aria-label="Application state counts">
          {Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([state, count]) => <span key={state}>{label(state)}: {count}</span>)}
          {!applications.length && <span className={styles.muted}>No applications yet.</span>}
        </div>
      </section>
      <section className={styles.section} aria-labelledby="history-heading">
        <div className={styles.row}><h2 id="history-heading">Application history</h2><span className={styles.muted}>Latest {applications.length} records</span></div>
        {!applications.length ? <p className={styles.muted}>Start a run from Workers after enabling a policy.</p> :
          <ul className={styles.applications} aria-label="Application history">
            {applications.map((app) => <li key={app.id}>
              <div className={styles.row}><strong>{app.company ?? 'Company pending official context'}</strong><span>{label(app.state)}</span></div>
              <div className={styles.row}><span>{app.role ?? `Requisition ${app.requisition}`}</span><span className={styles.muted}>{app.ats} / {app.tenant}</span></div>
              <div className={styles.row}><span className={styles.muted}>Application {short(app.id)} / run {short(app.runId)} / revision {app.revision}</span>
                {app.checkpoint && <span className={styles.muted}>Checkpoint: {app.checkpoint.stage}</span>}</div>
              <div className={styles.row}><span className={styles.muted}>Provider: worker-local configuration / cost: not reported</span>
                {app.receiptId && <span>Receipt {app.receiptId}{app.submittedAt ? ` / ${new Date(app.submittedAt).toLocaleString()}` : ''}</span>}</div>
              {app.reasonCode && <span className={styles.reason}>Reason: {label(app.reasonCode)}</span>}
              {materials.get(app.id) && <MaterialsPanel item={materials.get(app.id)!} />}
              {app.state === 'needs_document' && app.checkpoint && isSafeRetryState(app.state, app.reasonCode) && view.account &&
                <RetryPanel app={app} runs={view.runs?.runs ?? []} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
              {isAwaitingSubmitApproval(app.state, app.reasonCode) && view.account &&
                <ApprovePanel app={app} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
              {outreach.get(app.id) && view.account && <OutreachPanel key={`${app.id}:${outreach.get(app.id)!.updatedAt}`}
                item={outreach.get(app.id)!} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
            </li>)}
          </ul>}
      </section>
    </>}
  </>;
}
