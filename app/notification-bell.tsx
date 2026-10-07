'use client';

import dynamic from 'next/dynamic';
import { Bell } from 'lucide-react';
import styles from './inbox/inbox.module.css';

/**
 * The inbox client — its Zod protocols, question form and documents pane — was most of the
 * JavaScript every page parsed and ran before it could hydrate. It now loads after the page
 * is interactive; until then the header shows the same button, inert.
 */
export const NotificationBell = dynamic(() => import('./inbox/bell').then((m) => m.InboxBell), {
  ssr: false,
  loading: () => (
    <button className={styles.bell} type="button" aria-label="Notification inbox: loading" disabled>
      <Bell size={17} strokeWidth={1.5} aria-hidden="true" />
    </button>
  ),
});
