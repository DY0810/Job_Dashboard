'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { z } from 'zod';
import { outreachBadge } from '../../lib/applications/badges';
import { OutreachListSchema, type Outreach } from '../../lib/applications/worker-protocol';
import { OutreachPanel } from '../applications/applications';
import { privateJson } from '../profile/api';
import { StatusBadge } from '../status-badge';
import styles from '../workers/workers.module.css';

const ApplicantSchema = z.object({ ownerId: z.string().min(1) });
type View = { ownerId: string; items: Outreach[]; loading: boolean; error: string };

/** The recruiter emails Auto Apply drafted, queued and sent, newest first; unsent ones can be sent from here. */
export default function Emails() {
  const [view, setView] = useState<View>({ ownerId: '', items: [], loading: true, error: '' });
  const load = useCallback(async () => {
    try {
      const { ownerId } = ApplicantSchema.parse(await privateJson('/api/auth/applicant', { timeout: 15_000 }));
      const list = OutreachListSchema.parse(await privateJson('/api/outreach', { owner: ownerId, timeout: 15_000 }));
      const at = (item: Outreach) => item.sentAt ?? item.sendAfter ?? item.updatedAt;
      setView({ ownerId, items: [...list.outreach].sort((a, b) => at(b) - at(a)), loading: false, error: '' });
    } catch {
      setView((current) => ({ ...current, ownerId: '', loading: false, error: 'Recruiter emails are unavailable. Sign in and try again.' }));
    }
  }, []);
  useEffect(() => {
    void load();
    const refresh = () => void load();
    window.addEventListener('workie:refresh', refresh);
    return () => window.removeEventListener('workie:refresh', refresh);
  }, [load]);

  const sent = view.items.filter((item) => item.status === 'sent').length;
  return <>
    <div className={styles.toolbar}>
      <h1>Emails</h1>
      {view.ownerId && <StatusBadge tone="applied" label={`${sent} sent`} />}
    </div>
    {view.error && <p role="alert" className={styles.message}>{view.error} <Link href="/sign-in" prefetch={false}>Sign in</Link></p>}
    {view.ownerId && !view.items.length && <p className={`${styles.message} ${styles.muted}`}>
      No recruiter emails yet. Auto Apply drafts one after each submitted application when recruiter email is on in your policy.</p>}
    {view.items.length > 0 && <ul className={styles.cards} aria-label="Recruiter emails">
      {view.items.map((item) => <li key={item.applicationId} className={styles.card}>
        <div className={styles.cardTitle}>
          <h2 title={`${item.company} / ${item.role}`}>{item.company}<span className={styles.slash}> / </span>{item.role}</h2>
          <StatusBadge {...outreachBadge(item.status, item.reason)} />
        </div>
        {item.to && <span className={styles.muted}>To {item.name ? `${item.name} <${item.to}>` : item.to}{item.source ? ` · via ${item.source}` : ''}</span>}
        <OutreachPanel key={item.updatedAt} item={item} ownerId={view.ownerId} onChange={() => void load()} />
      </li>)}
    </ul>}
  </>;
}
