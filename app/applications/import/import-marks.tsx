'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from '../../icons';
import { DiscoveryControl, initialDiscoveryView, safePostingUrl, type DiscoveryView } from './control';
import styles from '../../workers/workers.module.css';
import local from './import.module.css';

export default function ImportMarks() {
  const [view, setView] = useState<DiscoveryView>(initialDiscoveryView);
  const control = useRef<DiscoveryControl | null>(null);
  useEffect(() => {
    const item = new DiscoveryControl(setView);
    control.current = item;
    void item.refreshSession();
    const focus = () => { if (document.visibilityState === 'visible') void item.refreshSession(); };
    const visibility = () => { if (document.visibilityState === 'hidden') item.suspend(); else focus(); };
    const unload = (event: BeforeUnloadEvent) => {
      if (item.view.pending) { event.preventDefault(); event.returnValue = ''; }
    };
    const navigation = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (!item.view.pending || !link || link.target === '_blank' || event.metaKey || event.ctrlKey ||
          new URL(link.href).pathname === '/applications/import') return;
      event.preventDefault(); event.stopPropagation(); item.preventNavigation();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('beforeunload', unload);
    document.addEventListener('click', navigation, true);
    return () => {
      item.dispose(); control.current = null;
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('beforeunload', unload);
      document.removeEventListener('click', navigation, true);
    };
  }, []);
  const disabled = view.locked || view.busy || !!view.pending;
  return <>
    <div className={styles.toolbar}>
      <h1>Import browser marks</h1>
      {!view.locked && <span className={styles.muted}>{view.account?.email}</span>}
      <button className={styles.button} type="button" disabled={view.busy}
        onClick={() => void control.current?.refreshSession()}>Check session</button>
    </div>
    {view.error && <p role="alert" className={styles.message}>{view.error}</p>}
    {view.locked && <p className={styles.row}>
      <span>{view.busy ? 'Checking applicant session...' : 'Import locked.'}</span>
      {!view.busy && <Link href="/sign-in" prefetch={false} target="_blank" rel="noopener noreferrer">Sign in</Link>}
    </p>}
    <div hidden={view.locked}>
      <section className={styles.section} aria-labelledby="browser-marks-heading">
        <div className={styles.row}>
          <h2 id="browser-marks-heading">Manual application history</h2>
          <button className={styles.button} type="button" disabled={disabled} onClick={() => {
            try { void control.current?.preview(window.localStorage); } catch { control.current?.storageDenied(); }
          }}>Preview browser marks</button>
        </div>
        <p className={styles.muted}>Browser-local marks / ownership unconfirmed / not employer receipts</p>
        {view.notice && <p role="status" className={styles.message}>{view.notice}</p>}
        {view.pending && <div className={styles.message}>
          <span>{view.busy ? 'Request pending' : 'Acknowledgement unresolved'}: {view.pending.kind}</span>
          <button className={styles.button} type="button" disabled={view.busy}
            onClick={() => void control.current?.retry()}>Retry pending request</button>
        </div>}
        {view.preview && <>
          <div className={styles.row}>
            <span>{view.preview.rows.length} browser marks / {view.selected.length} selected</span>
            <span className={styles.muted}>Preview expires {new Date(view.preview.expiresAt).toLocaleString()} (server-enforced)</span>
          </div>
          <ul className={local.rows} aria-label="Browser marks">
            {view.preview.rows.map((row) => {
              const url = safePostingUrl(row.url);
              return <li key={row.postingId}>
                <label className={local.check}>
                  <input type="checkbox" aria-label={`Select posting ${row.postingId}`} checked={view.selected.includes(row.postingId)}
                    disabled={disabled || !!view.ack} onChange={(event) => control.current?.select(row.postingId, event.target.checked)} />
                  <span>#{row.postingId}</span>
                </label>
                <div className={local.role}>
                  <strong>{row.company ?? 'Unknown employer'}</strong>
                  <span>{row.title ?? 'Posting unavailable'}</span>
                </div>
                <span>{row.resolution === 'resolved' ? 'Resolved manual mark' : 'Unresolved manual record'}</span>
                {url ? <a href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
                  className={`${styles.button} ${styles.icon}`} title={`Open posting ${row.postingId}`}
                  aria-label={`Open posting ${row.postingId}`}><ExternalLink /></a> : <span className={styles.muted}>No safe link</span>}
              </li>;
            })}
          </ul>
          <div className={local.confirm}>
            <label className={local.check}>
              <input type="checkbox" checked={view.ownership} disabled={disabled || !!view.ack || view.expired}
                onChange={(event) => control.current?.confirmOwnership(event.target.checked)} />
              <span>I own the selected application marks and assign them to {view.account?.email}.</span>
            </label>
            <button className={styles.button} type="button"
              disabled={disabled || !!view.ack || view.expired || !view.ownership || !view.selected.length}
              onClick={() => void control.current?.confirm()}>Import selected marks</button>
          </div>
          {view.ack && <p className={styles.muted}>
            Manual reported: {view.ack.importedPostingIds.length} / Resolved: {view.ack.resolvedCount} / Unresolved: {view.ack.unresolvedCount}
          </p>}
        </>}
      </section>
    </div>
  </>;
}
