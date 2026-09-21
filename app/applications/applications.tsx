'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { EXPECTED_APPLICANT_HEADER } from '../../lib/applications/applicant-precondition';
import { HEARTBEAT_MS, RunListSchema, WorkerListSchema } from '../../lib/applications/worker-protocol';
import { PolicySchema } from '../../lib/applications/policy';
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
  loading: boolean;
  locked: boolean;
  error: string;
};

const initialView: View = { account: null, workers: null, runs: null, policy: null, loading: true, locked: true, error: '' };

async function request(path: string, ownerId?: string) {
  const headers = new Headers();
  if (ownerId) headers.set(EXPECTED_APPLICANT_HEADER, ownerId);
  const response = await fetch(path, {
    headers, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(response.status === 401 ? 'Sign in to view private applications.' :
    response.status === 403 ? 'Applicant access denied.' : 'Private application status is unavailable.');
  return body;
}

export default function Applications() {
  const [view, setView] = useState(initialView);
  const [refreshing, setRefreshing] = useState(false);
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setView((current) => ({ ...current, loading: true, locked: true, error: '' }));
    else setRefreshing(true);
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant'));
      const [workers, runs, policy] = await Promise.all([
        WorkerListSchema.parse(await request('/api/workers', account.ownerId)),
        RunListSchema.parse(await request('/api/application-runs', account.ownerId)),
        PolicyResponseSchema.parse(await request('/api/auto-apply/policies', account.ownerId)),
      ]);
      if (workers.ownerId !== account.ownerId || runs.ownerId !== account.ownerId) throw new Error('Account changed. Refresh the current applicant.');
      setView({ account, workers, runs, policy, loading: false, locked: false, error: '' });
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
            </li>)}
          </ul>}
      </section>
    </>}
  </>;
}
