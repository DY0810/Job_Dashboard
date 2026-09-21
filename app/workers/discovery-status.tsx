'use client';

import { useEffect, useRef, useState } from 'react';
import type { Run } from '../../lib/applications/worker-protocol';
import { DiscoveryControl, initialDiscoveryView, type DiscoveryView } from '../applications/import/control';
import styles from './workers.module.css';

const date = (value: number | null) => value === null ? 'Never' : new Date(value).toLocaleString();
const countLabels = {
  eligible: 'Eligible', duplicate: 'Duplicate', unresolved: 'Unresolved',
  held_policy: 'Held by policy', held_cap: 'Held by cap', manual_reported: 'Manual reported',
};

export default function DiscoveryStatus({ ownerId, runs, locked }: { ownerId: string; runs: Run[]; locked: boolean }) {
  const [view, setView] = useState<DiscoveryView>(initialDiscoveryView);
  const control = useRef<DiscoveryControl | null>(null);
  useEffect(() => {
    const item = new DiscoveryControl(setView, ownerId);
    control.current = item;
    return () => { item.dispose(); control.current = null; };
  }, [ownerId]);
  useEffect(() => {
    if (locked) control.current?.suspend();
    if (view.runId && !runs.some((run) => run.id === view.runId)) control.current?.selectRun('');
  }, [locked, runs, view.runId]);
  const status = view.status;
  return <section className={styles.section} aria-labelledby="discovery-heading">
    <h2 id="discovery-heading">Discovery</h2>
    <div className={styles.form}>
      <label>Discovery run
        <select value={view.runId} disabled={locked} onChange={(event) => control.current?.selectRun(event.target.value)}>
          <option value="">Select run</option>
          {runs.map((run) => <option key={run.id} value={run.id}>Run {run.id.slice(0, 8)} / {run.state}</option>)}
        </select>
      </label>
      <button className={styles.button} type="button" disabled={locked || view.busy || !view.runId}
        onClick={() => void control.current?.refreshStatus()}>Refresh discovery</button>
    </div>
    {view.error && <p className={styles.message} role="alert">{view.error}</p>}
    {view.statusStale && status && !view.locked && <p role="status">Refresh failed. Showing the last fetched status.</p>}
    {status && !locked && !view.locked && <>
      <div className={styles.row}>
        <strong>{status.state === 'failed' ? 'Scan failed' : status.state.replaceAll('_', ' ')}</strong>
        <span>{Object.values(status.counts).reduce((sum, count) => sum + count, 0)} retained targets</span>
        <span className={styles.muted}>All run targets, including earlier backlog</span>
      </div>
      <dl className={styles.row} aria-label="Retained target counts">
        {Object.entries(countLabels).map(([key, name]) => <div key={key} className={styles.row}>
          <dt>{name}</dt><dd>{status.counts[key as keyof typeof countLabels]}</dd>
        </div>)}
      </dl>
      <div className={styles.row}>
        <span>Current manifest</span><strong>{status.stagedCount} / {status.candidateCount} staged</strong>
        <span className={styles.muted}>{status.manifestId ? `Manifest ${status.manifestId.slice(0, 8)}` : 'No manifest'}</span>
        <span className={styles.muted}>Captured: {date(status.capturedAt)}</span>
      </div>
      <p className={styles.muted} data-testid="last-successful-scan">Last successful scan: {date(status.lastScanAt)}</p>
      <p className={styles.muted}>Last attempt: {date(status.lastAttemptAt)}</p>
      {status.errorCode && <p role="status">Discovery reported an error. Last successful scan is unchanged.</p>}
      <p className={styles.muted}>Daily cap: applications started per UTC day</p>
    </>}
  </section>;
}
