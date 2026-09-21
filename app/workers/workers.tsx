'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { Close } from '../icons';
import { HEARTBEAT_MS } from '../../lib/applications/worker-protocol';
import { WorkerControl, applicationActions, initialView, pairingStatus, workerStatus, type WorkerView } from './control';
import DiscoveryStatus from './discovery-status';
import styles from './workers.module.css';

const label = (value: string) => value.replaceAll('_', ' ');
const date = (value: number | null) => value === null ? 'Never' : new Date(value).toLocaleString();
const short = (id: string) => id.slice(0, 8);

export default function Workers() {
  const [view, setView] = useState<WorkerView>(initialView);
  const control = useRef<WorkerControl | null>(null);
  useEffect(() => {
    const item = new WorkerControl(setView);
    control.current = item;
    void item.refresh();
    const focus = () => { if (document.visibilityState === 'visible') void item.refresh(); };
    const visibility = () => { if (document.visibilityState === 'hidden') item.suspend(); else focus(); };
    const clock = setInterval(() => item.tick(), 1000);
    const poll = setInterval(() => {
      if (document.visibilityState === 'visible' && !item.view.busy && !item.view.loading && !item.view.locked) void item.refresh(true);
    }, HEARTBEAT_MS);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (item.view.pending || item.view.grant) { event.preventDefault(); event.returnValue = ''; }
    };
    const navigation = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!item.view.pending || !link || link.target === '_blank' || event.metaKey || event.ctrlKey ||
          new URL(link.href).pathname === '/workers') return;
      event.preventDefault(); event.stopPropagation();
      item.preventNavigation();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('beforeunload', beforeUnload);
    document.addEventListener('click', navigation, true);
    return () => {
      item.dispose(); control.current = null;
      clearInterval(clock); clearInterval(poll);
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('beforeunload', beforeUnload);
      document.removeEventListener('click', navigation, true);
    };
  }, []);
  return <>
    <div className={styles.toolbar}>
      <h1>Workers</h1>
      <Link href="/applications/import" prefetch={false}>Import browser marks</Link>
      {!view.locked && <span className={styles.muted}>{view.account?.email}</span>}
      <button type="button" className={styles.button} disabled={view.loading} onClick={() => void control.current?.refresh()}>
        Refresh status
      </button>
    </div>
    {view.loading && view.locked && <p role="status">Checking applicant session...</p>}
    {view.error && <p role="alert" className={styles.message}>{view.error}</p>}
    {view.locked && !view.loading && <p className={styles.row}>
      <span>Workers locked.</span>
      <Link href="/sign-in" prefetch={false} target="_blank" rel="noopener noreferrer">Sign in</Link>
    </p>}
    {view.account && <div hidden={view.locked}>
      <WorkerPanel key={view.account.ownerId} view={view} control={control.current!} />
    </div>}
  </>;
}

function WorkerPanel({ view, control }: { view: WorkerView; control: WorkerControl }) {
  const [name, setName] = useState('');
  const [selected, setSelected] = useState('');
  const disabled = view.busy || !!view.pending;
  const workers = view.workers?.workers ?? [];
  const runs = view.runs?.runs ?? [];
  const grant = view.grant;
  const selectedWorker = workers.find((w) => w.id === selected && w.revokedAt === null);
  return <>
    {view.notice && <p role="status" className={styles.message}>{view.notice}</p>}
    {view.pending && <div className={styles.message} role="status">
      <span>{view.busy ? 'Request pending' : 'Acknowledgement unresolved'}: {view.pending.title}</span>
      <button type="button" className={styles.button} disabled={view.busy} onClick={() => void control.retry()}>Retry pending request</button>
    </div>}
    <section className={styles.section} aria-labelledby="pairing-heading">
      <h2 id="pairing-heading">Pairing</h2>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void control.createPairing(name); }}>
        <label>Worker label
          <input name="worker-label" value={name} onChange={(event) => setName(event.target.value)}
            required maxLength={80} autoComplete="off" disabled={disabled || !!grant} />
        </label>
        <button type="submit" className={styles.button} disabled={disabled || !!grant || !name.trim()}>Create pairing grant</button>
      </form>
      {grant && <div className={styles.secret} aria-label="New pairing grant">
        <span className={styles.muted}>One-time secret / this tab only / unavailable after leaving</span>
        <label>Pairing grant
          <textarea readOnly rows={2} value={grant.grant} autoComplete="off" spellCheck={false} />
        </label>
        <span className={styles.muted}>Expires {date(grant.expiresAt)}</span>
        <div className={styles.row}>
          <button type="button" className={styles.button} onClick={() => void control.copySecret()}>Copy grant</button>
          <button type="button" className={`${styles.button} ${styles.icon}`} aria-label="Dismiss secret" title="Dismiss secret"
            onClick={() => control.clearSecret()}><Close /></button>
        </div>
      </div>}
      {!view.workers?.pairings.length ? <p className={styles.muted}>No pairing grants.</p> :
        <ul className={styles.list} aria-label="Pairing grants">{view.workers.pairings.map((pairing) => <li key={pairing.id}>
          <div><strong>{pairing.label}</strong><span className={styles.muted}> / {short(pairing.id)}</span></div>
          <span>{pairingStatus(pairing, view.now)}</span>
          <span className={styles.muted}>Expires {date(pairing.expiresAt)}</span>
          <div>{pairing.revokedAt === null && pairing.consumedAt === null &&
            <button className={styles.button} type="button" disabled={disabled} onClick={() => void control.revoke('pairing', pairing)}
              aria-label={`Cancel pairing ${pairing.label}`}>Cancel pairing</button>}</div>
        </li>)}</ul>}
    </section>
    <section className={styles.section} aria-labelledby="paired-heading">
      <h2 id="paired-heading">Paired workers</h2>
      {!workers.length ? <p className={styles.muted}>Unpaired / no workers.</p> : <ul className={styles.list} aria-label="Workers">
        {workers.map((worker) => <li key={worker.id}>
          <div><strong>{worker.label}</strong><span className={styles.muted}> / {short(worker.id)}</span>
            <div className={styles.muted}>Version {worker.workerVersion} / {worker.capabilities.join(', ')}</div></div>
          <span>{workerStatus(worker, view.now)}</span>
          <span className={styles.muted}>Last heartbeat {date(worker.lastSeenAt)}</span>
          <div>{worker.revokedAt === null && <button type="button" className={styles.button} disabled={disabled}
            aria-label={`Revoke ${worker.label}`} onClick={() => void control.revoke('worker', worker)}>Revoke</button>}</div>
        </li>)}
      </ul>}
    </section>
    <section className={styles.section} aria-labelledby="runs-heading">
      <h2 id="runs-heading">Runs</h2>
      <p className={styles.muted}>
        {view.policy?.enabled ? 'Policy intent enabled' : 'Policy disabled'} / Execution disabled / Runner unavailable
      </p>
      <form className={styles.form} onSubmit={(event) => { event.preventDefault(); void control.createRun(selected); }}>
        <label>Run worker
          <select value={selected} onChange={(event) => setSelected(event.target.value)} disabled={disabled}>
            <option value="">Select worker</option>
            {workers.filter((worker) => worker.revokedAt === null).map((worker) =>
              <option key={worker.id} value={worker.id}>{worker.label} / {workerStatus(worker, view.now)}</option>)}
          </select>
        </label>
        <button type="submit" className={styles.button} disabled={disabled || !selectedWorker || !view.policy?.enabled}>Create run</button>
        <Link href="/profile#auto-apply-policy" prefetch={false}>Policy</Link>
      </form>
      {!runs.length ? <p className={styles.muted}>No runs.</p> : <ul className={styles.runs} aria-label="Runs">
        {runs.map((run) => <li key={run.id} aria-label={`Run ${short(run.id)}`}>
          <div className={styles.row}>
            <strong>Run {short(run.id)}</strong>
            <span>{label(run.state)}</span>
            <span className={styles.muted}>Revision {run.revision} / {workers.find((w) => w.id === run.workerId)?.label ?? short(run.workerId)}</span>
            <span className={styles.muted}>{date(run.createdAt)}</span>
          </div>
          <div className={styles.actions}>
            {run.state === 'running' && <button className={styles.button} type="button" disabled={disabled}
              onClick={() => void control.commandRun(run, 'pause')}>Pause</button>}
            {run.state === 'paused' && <button className={styles.button} type="button" disabled={disabled || !view.policy?.enabled ||
              !workers.some((w) => w.id === run.workerId && w.revokedAt === null)}
              onClick={() => void control.commandRun(run, 'resume')}>Resume</button>}
            {run.state !== 'stopped' && <>
              <button className={styles.button} type="button" disabled={disabled}
                onClick={() => void control.commandRun(run, 'stop')}>Stop</button>
              <button className={styles.button} type="button" disabled={view.busy && view.pending?.body.action === 'emergency-stop'}
                onClick={() => void control.commandRun(run, 'emergency-stop')}>Emergency stop</button>
            </>}
          </div>
        </li>)}
      </ul>}
    </section>
    <DiscoveryStatus ownerId={view.account!.ownerId} runs={runs} locked={view.locked} />
    <section className={styles.section} aria-labelledby="applications-heading">
      <h2 id="applications-heading">Application state</h2>
      {!view.runs?.applications.length ? <p className={styles.muted}>No applications.</p> :
        <ul className={styles.applications} aria-label="Application states">
          {view.runs.applications.map((app) => <li key={app.id} aria-label={`Application ${app.requisition}`}>
            <div className={styles.row}><strong>{app.tenant} / {app.requisition}</strong>
              <span className={styles.muted}>{app.ats} / Run {short(app.runId)} / Revision {app.revision}</span></div>
            <div className={styles.row}><span>{label(app.state)}</span>
              {app.reasonCode && <span className={styles.reason}>Reason: {app.reasonCode}</span>}
              {app.checkpoint && <span className={styles.muted}>Checkpoint: {app.checkpoint.stage}</span>}
            </div>
            <div className={styles.actions}>
              {applicationActions(app, runs.find((run) => run.id === app.runId)).map((action) =>
                <button className={styles.button} type="button" key={action}
                  disabled={action === 'emergency-stop' ? view.busy && view.pending?.body.action === action : disabled}
                  onClick={() => void control.commandApplication(app, action)}>
                  {action === 'retry-safe' ? 'Retry safe' : action === 'emergency-stop' ? 'Emergency stop' :
                    action === 'skip' ? 'Skip' : 'Cancel'}
                </button>)}
            </div>
          </li>)}
        </ul>}
    </section>
  </>;
}
