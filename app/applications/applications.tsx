'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition';
import { HEARTBEAT_MS, MaterialsSchema, OutreachListSchema, RunCreateSchema, RunListSchema, WorkerListSchema, type Outreach, type Run } from '../../lib/applications/worker-protocol';
import { PolicySchema } from '../../lib/applications/policy';
import { isAwaitingSubmitApproval, isSafeRetryState } from '../../lib/applications/state';
import { privateJson, PrivateRequestError } from '../profile/api';
import styles from '../workers/workers.module.css';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const PolicyResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.boolean(),
});
const label = (value: string) => value.replaceAll('_', ' ');

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

async function request(path: string, owner?: string) {
  try {
    return await privateJson(path, { owner, timeout: 15_000 });
  } catch (error) {
    if (!(error instanceof PrivateRequestError)) throw error;
    throw new Error(error.status === 401 ? 'Unlock Workie to view private applications.' :
      error.status === 403 ? 'Applicant access denied.' : 'Private application status is unavailable.');
  }
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
      await privateJson(`/api/application-runs/${app.runId}/applications/${app.id}/actions`, {
        method: 'POST', owner: ownerId, timeout: 30_000,
        body: JSON.stringify({ action: 'approve-submit', requestId: crypto.randomUUID(), expectedRevision: app.revision }),
      });
      onChange();
    } catch (e) {
      setError(e instanceof PrivateRequestError ? (e.status === 403 ? 'Turn on Submit in the Auto Apply policy first.' : 'Could not approve. Refresh and try again.')
        : e instanceof Error ? e.message : 'Could not approve.');
    }
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

const postCommand = (path: string, ownerId: string, expectedRevision: number, body: object) => fetch(path, {
  method: 'POST', credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(30_000),
  headers: { 'content-type': 'application/json', [EXPECTED_APPLICANT_HEADER]: ownerId },
  body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision, ...body }),
});
const errorCode = async (response: Response) => (await response.clone().json().catch(() => null))?.code as string | undefined;

/** Restart queues a fresh attempt of a role the employer never received; delete hides the row (and cancels it if live). */
function ManagePanel({ app, runs, ownerId, onChange }: { app: { id: string; runId: string; revision: number; state: string }; runs: Run[]; ownerId: string; onChange: () => void }) {
  const [busy, setBusy] = useState<'restart' | 'delete' | null>(null);
  const [error, setError] = useState('');
  const restartable = !['submitted', 'submitting', 'submission_unknown'].includes(app.state);
  const restart = async () => {
    setBusy('restart'); setError('');
    try {
      // Its own run first, then other running runs newest first; the server takes only a running run on the current policy.
      const targets = runs.filter((run) => run.state === 'running').sort((a, b) => Number(b.id === app.runId) - Number(a.id === app.runId));
      if (!targets.length) throw new Error('No run is running. Start one from Workers, then restart.');
      let response: Response | null = null;
      for (const run of targets) {
        response = await postCommand(`/api/application-runs/${run.id}/restart`, ownerId, app.revision, { previousApplicationId: app.id });
        if (response.ok || !['POLICY_CHANGED', 'DISCOVERY_REQUIRED'].includes(await errorCode(response) ?? '')) break;
      }
      if (!response!.ok) {
        const code = await errorCode(response!);
        throw new Error(code === 'POLICY_CHANGED' ? 'The Auto Apply policy changed since the running run started. Start a new run from Workers, then restart.'
          : code === 'DISCOVERY_REQUIRED' ? 'No running run has found this role yet. Restart after its discovery finishes.'
          : code === 'DUPLICATE_BLOCKED' ? 'This role was already retried or marked applied.' : 'Could not restart. Refresh and try again.');
      }
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not restart.'); }
    finally { setBusy(null); }
  };
  const remove = async () => {
    if (!window.confirm(restartable && !['failed', 'skipped', 'cancelled'].includes(app.state)
      ? 'Cancel this application and remove it from the list?' : 'Remove this application from the list?')) return;
    setBusy('delete'); setError('');
    try {
      const response = await postCommand(`/api/application-runs/${app.runId}/applications/${app.id}/actions`, ownerId, app.revision, { action: 'delete' });
      if (!response.ok) throw new Error('Could not delete. Refresh and try again.');
      onChange();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not delete.'); }
    finally { setBusy(null); }
  };
  return <div className={styles.row}>
    {restartable && <button className={styles.button} type="button" disabled={!!busy} onClick={() => void restart()}>
      {busy === 'restart' ? 'Restarting...' : app.state === 'cancelled' ? 'Restart cancelled' : 'Restart'}</button>}
    {!['submitting', 'submission_unknown'].includes(app.state) &&
      <button className={styles.button} type="button" disabled={!!busy} onClick={() => void remove()}>{busy === 'delete' ? 'Deleting...' : 'Delete'}</button>}
    {error && <span role="alert" className={styles.reason}>{error}</span>}
  </div>;
}

/** Starts a run on the first online worker, the same create-run call as Workers; the run then finds and fills roles on its own. */
function StartPanel({ workerId, policyEnabled, ownerId, onChange }: { workerId: string | undefined; policyEnabled: boolean; ownerId: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true); setError('');
    try {
      await privateJson('/api/application-runs', { method: 'POST', owner: ownerId, timeout: 30_000,
        body: JSON.stringify(RunCreateSchema.parse({ workerId, requestId: crypto.randomUUID(), expectedRevision: 0 })) });
      onChange();
    } catch { setError('Could not start. Check the worker and policy on Workers, then try again.'); }
    finally { setBusy(false); }
  };
  if (!policyEnabled) return <div className={styles.row}><span>Turn on the Auto Apply policy in Profile to start.</span></div>;
  if (!workerId) return <div className={styles.row}><span>Start a worker to begin auto applying.</span><Link href="/workers" prefetch={false}>Workers</Link></div>;
  return <div className={styles.row}>
    <span>No run is going.</span>
    <button className={styles.button} type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Starting...' : 'Start auto apply'}</button>
    {error && <span role="alert" className={styles.reason}>{error}</span>}
  </div>;
}

/** A document hold the applicant has fixed resumes here, in its own run or, after a policy change, in the newest running run. */
function RetryPanel({ app, runs, ownerId, onChange }: { app: { id: string; runId: string; revision: number; reasonCode: string | null }; runs: Run[]; ownerId: string; onChange: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const post = (path: string, body: object) => postCommand(path, ownerId, app.revision, body);
  const retry = async () => {
    setBusy(true); setError('');
    try {
      let response = await post(`/api/application-runs/${app.runId}/applications/${app.id}/actions`, { action: 'retry-safe' });
      const code = async () => response.status === 409 ? (await response.clone().json().catch(() => null))?.code : undefined;
      if (await code() === 'POLICY_CHANGED') {
        // The server accepts only a run on the current policy; try running runs newest first.
        for (const run of runs.filter((item) => item.state === 'running' && item.id !== app.runId)) {
          response = await post(`/api/application-runs/${run.id}/retry-unsubmitted`, { previousApplicationId: app.id });
          if (await code() !== 'POLICY_CHANGED') break;
        }
        if (await code() === 'POLICY_CHANGED') throw new Error('The Auto Apply policy changed after this run started. Start a new run from Workers, then retry.');
        if (await code() === 'DISCOVERY_REQUIRED') throw new Error('The new run has not found this role yet. Retry after its discovery finishes.');
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
      // 60s matches the route's maxDuration: a shorter client abort would hide a send that went out.
      await privateJson(`/api/outreach/${item.applicationId}`, {
        method: 'POST', owner: ownerId, timeout: 60_000,
        body: JSON.stringify({ to: to.trim(), name: to.trim() === item.to ? item.name : null, now }),
      });
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
        <h2 id="status-heading">Status</h2>
        <div className={styles.row}>
          <span>{onlineWorkers.length ? `${onlineWorkers.length} worker${onlineWorkers.length === 1 ? '' : 's'} online` : 'No worker online'}</span>
          <span className={styles.muted}>{view.policy?.enabled ? 'Policy enabled' : 'Policy disabled'}</span>
          <Link href="/workers" prefetch={false}>Manage workers</Link>
        </div>
        {view.account && !view.runs?.runs.some((run) => run.state === 'running') &&
          <StartPanel workerId={onlineWorkers.find((worker) => worker.revokedAt === null)?.id} policyEnabled={!!view.policy?.enabled}
            ownerId={view.account.ownerId} onChange={() => void load(true)} />}
        {applications.length > 0 && <div className={styles.row} aria-label="Application state counts">
          {Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)).map(([state, count]) =>
            <span key={state}>{count} <span className={styles.muted}>{label(state)}</span></span>)}
        </div>}
      </section>
      <section className={styles.section} aria-labelledby="history-heading">
        <h2 id="history-heading">History</h2>
        {!applications.length ? <p className={styles.muted}>Start a run from Workers after enabling a policy.</p> :
          <ul className={styles.applications} aria-label="Application history">
            {applications.map((app) => {
              const retry = app.state === 'needs_document' && !!app.checkpoint && isSafeRetryState(app.state, app.reasonCode) && (app.retries ?? 0) < 3;
              const approve = isAwaitingSubmitApproval(app.state, app.reasonCode);
              return <li key={app.id}>
                <div className={styles.row}><strong>{app.company ?? app.tenant}</strong><span className={styles.muted}>{label(app.state)}</span></div>
                <div className={styles.row}><span>{app.role ?? `Requisition ${app.requisition}`}</span><span className={styles.muted}>{app.ats}</span>
                  {app.receiptId && <span className={styles.muted}>Receipt {app.receiptId}{app.submittedAt ? `, ${new Date(app.submittedAt).toLocaleString()}` : ''}</span>}</div>
                {/* The retry and approve panels explain their own hold, so the raw reason would repeat them. */}
                {app.reasonCode && !retry && !approve && <span className={styles.reason}>Reason: {label(app.reasonCode)}</span>}
                {materials.get(app.id) && <MaterialsPanel item={materials.get(app.id)!} />}
                {retry && view.account &&
                  <RetryPanel app={app} runs={view.runs?.runs ?? []} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
                {approve && view.account &&
                  <ApprovePanel app={app} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
                {view.account && <ManagePanel app={app} runs={view.runs?.runs ?? []} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
                {outreach.get(app.id) && view.account && <OutreachPanel key={`${app.id}:${outreach.get(app.id)!.updatedAt}`}
                  item={outreach.get(app.id)!} ownerId={view.account.ownerId} onChange={() => void load(true)} />}
              </li>;
            })}
          </ul>}
      </section>
    </>}
  </>;
}
