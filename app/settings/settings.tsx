'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { z } from 'zod';
import { privateJson, PrivateRequestError } from '../profile/api';
import { PolicySchema } from '../../lib/applications/policy';
import { RunCreateSchema, RunListSchema, WorkerListSchema, WorkerScheduleSchema, type WorkerSummary } from '../../lib/applications/worker-protocol';
import { formatDailyStart } from '../../lib/applications/schedule';
import styles from '../workers/workers.module.css';

const ApplicantSchema = z.strictObject({ ownerId: z.string().min(1), email: z.email(), name: z.string() });
const PolicyResponseSchema = z.strictObject({
  revision: z.number().int().nonnegative(), policy: PolicySchema, enabled: z.boolean(),
  policyVersion: z.number().int().nonnegative(), policyHash: z.string().nullable(),
  acceptedPolicyVersion: z.number().nullable(), acceptedPolicyHash: z.string().nullable(),
  acceptedAt: z.string().nullable(), runnerAvailable: z.boolean(),
});

async function request(path: string, owner?: string) {
  try {
    return await privateJson(path, { owner, timeout: 15_000 });
  } catch (error) {
    if (!(error instanceof PrivateRequestError)) throw error;
    throw new Error(error.status === 401 ? 'Unlock Workie to view private settings.' : 'Private settings are unavailable.');
  }
}

const display = (value: string) => value.replaceAll('_', ' ');
const list = (values: string[]) => values.length ? values.join(', ') : 'None configured';

/** Starts a run on the first online worker, the same create-run call as Workers; the run then finds and fills roles on its own. */
function StartPanel({ workerId, policyEnabled, ownerId }: { workerId: string | undefined; policyEnabled: boolean; ownerId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const start = async () => {
    setBusy(true); setError('');
    try {
      await privateJson('/api/application-runs', { method: 'POST', owner: ownerId, timeout: 30_000,
        body: JSON.stringify(RunCreateSchema.parse({ workerId, requestId: crypto.randomUUID(), expectedRevision: 0 })) });
      window.dispatchEvent(new Event('workie:refresh'));
    } catch { setError('Could not start. Check the worker and policy, then try again.'); }
    finally { setBusy(false); }
  };
  if (!policyEnabled) return <div className={styles.row}><span>Turn on the Auto Apply policy in Profile to start.</span></div>;
  if (!workerId) return <div className={styles.row}><span>Pair and start a worker below to begin auto applying.</span></div>;
  return <div className={styles.row}>
    <span>No run is going.</span>
    <button className={styles.button} type="button" disabled={busy} onClick={() => void start()}>{busy ? 'Starting...' : 'Start auto apply now'}</button>
    {error && <span role="alert" className={styles.reason}>{error}</span>}
  </div>;
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

/** The server starts a run on this worker each day once this local time passes (pollWorker). Keyed by revision, so a save remounts it. */
function DailyStart({ worker, ownerId }: { worker: WorkerSummary | undefined; ownerId: string }) {
  const [value, setValue] = useState(worker?.dailyStartMinute == null ? '' : hhmm(worker.dailyStartMinute));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!worker) return <div className={styles.row}><span>Pair a worker below to schedule a daily start.</span></div>;
  const save = async (dailyStart: string | null) => {
    setBusy(true); setError('');
    try {
      await privateJson(`/api/workers/${worker.id}`, { method: 'PATCH', owner: ownerId, timeout: 15_000,
        body: JSON.stringify(WorkerScheduleSchema.parse({ requestId: crypto.randomUUID(), expectedRevision: worker.revision,
          dailyStart, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone })) });
      window.dispatchEvent(new Event('workie:refresh'));
    } catch { setError('Could not save the daily start. Refresh and try again.'); }
    finally { setBusy(false); }
  };
  return <div className={styles.row}>
    <span>{worker.dailyStartMinute === null ? 'No daily start.' : `Starts daily at ${formatDailyStart(worker.dailyStartMinute)} (${worker.timeZone})`}</span>
    <input type="time" aria-label="Daily start time" style={{ width: 'auto' }} value={value} onChange={(event) => setValue(event.target.value)} />
    <button className={styles.button} type="button" disabled={busy || !value} onClick={() => void save(value)}>Save</button>
    {worker.dailyStartMinute !== null &&
      <button className={styles.button} type="button" disabled={busy} onClick={() => void save(null)}>Clear</button>}
    {error && <span role="alert" className={styles.reason}>{error}</span>}
  </div>;
}

type Data = {
  account: z.infer<typeof ApplicantSchema>; policy: z.infer<typeof PolicyResponseSchema>;
  workers: z.infer<typeof WorkerListSchema>; runs: z.infer<typeof RunListSchema>;
};

/** The settings drawer body. `children` (Workers) sits between Auto Apply and the policy summary and never remounts on reload. */
export default function Settings({ children }: { children: ReactNode }) {
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setError('');
    try {
      const account = ApplicantSchema.parse(await request('/api/auth/applicant'));
      const [policy, workers, runs] = await Promise.all([
        request('/api/auto-apply/policies', account.ownerId).then((body) => PolicyResponseSchema.parse(body)),
        request('/api/workers', account.ownerId).then((body) => WorkerListSchema.parse(body)),
        request('/api/application-runs', account.ownerId).then((body) => RunListSchema.parse(body)),
      ]);
      if (workers.ownerId !== account.ownerId || runs.ownerId !== account.ownerId) throw new Error('Account changed. Refresh the current applicant.');
      setData({ account, policy, workers, runs });
    } catch (cause) {
      setData(null);
      setError(cause instanceof Error ? cause.message : 'Private settings are unavailable.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    void load();
    const reload = () => void load();
    window.addEventListener('workie:refresh', reload);
    return () => window.removeEventListener('workie:refresh', reload);
  }, [load]);

  const policy = data?.policy.policy;
  const running = data?.runs.runs.some((run) => run.state === 'running');
  const worker = data?.workers.workers.find((item) => item.online && item.revokedAt === null);
  const scheduled = worker ?? data?.workers.workers.find((item) => item.revokedAt === null);
  return <>
    <section className={styles.section} aria-labelledby="auto-apply-heading">
      <h3 id="auto-apply-heading">Auto Apply</h3>
      {loading && <p className={styles.message} role="status">Loading private settings...</p>}
      {error && <div className={styles.message}><span role="alert">{error}</span><Link href="/sign-in" prefetch={false}>Sign in</Link></div>}
      {data && <>
        <DailyStart key={scheduled ? `${scheduled.id}:${scheduled.revision}` : 'none'} worker={scheduled} ownerId={data.account.ownerId} />
        {running ? <div className={styles.row}><span>A run is going.</span></div> :
          <StartPanel workerId={worker?.id} policyEnabled={data.policy.enabled} ownerId={data.account.ownerId} />}
        <div className={styles.row}>
          <span className={styles.muted}>{data.policy.enabled ? 'Policy enabled' : 'Policy disabled'}</span>
          <Link href="/profile#auto-apply-policy" prefetch={false}>Edit policy in Profile</Link>
        </div>
      </>}
    </section>
    {children}
    {policy && <>
      <section className={styles.section} aria-labelledby="provider-heading">
        <h3 id="provider-heading">Provider</h3>
        <div className={styles.row}><span>{policy.allowedProviders.length > 0 ? 'Provider policy configured' : 'No provider selected'}</span><span className={styles.muted}>{display(policy.privacy)}</span></div>
        <p className={styles.muted}>Provider keys are read only by the paired worker from its OS keychain. This page never reads, stores or displays them.</p>
      </section>
      <section className={styles.section} aria-labelledby="budget-heading">
        <h3 id="budget-heading">Budget</h3>
        <div className={styles.row}>
          <span>Per request: {policy.budget.currency} {policy.budget.perRequest}</span>
          <span>Per run: {policy.budget.currency} {policy.budget.perRun}</span>
          <span>Per day: {policy.budget.currency} {policy.budget.perDay}</span>
        </div>
        <p className={styles.muted}>Current spend is local to the worker and is not exposed to the browser.</p>
      </section>
      <section className={styles.section} aria-labelledby="privacy-heading">
        <h3 id="privacy-heading">Privacy and account policy</h3>
        <div className={styles.row}><span>Remote consent: {policy.remoteProviderConsent ? 'on' : 'off'}</span><span>Fallback: {list(policy.fallbackOrder)}</span><span>New accounts: {display(policy.accountPolicy)}</span></div>
        <p className={styles.muted}>Confirmed facts and approved documents are the only values eligible for form filling. Unknown required questions pause only the affected application. Receipt evidence is required for a sent status; a timeout or missing confirmation stays submission unknown and is never retried blindly.</p>
      </section>
    </>}
  </>;
}
