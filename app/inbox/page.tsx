import type { Metadata } from 'next';
import { NotificationBell } from '../notification-bell';
import { ThemeToggle } from '../theme-toggle';
import { AppNav } from '../app-nav';
import styles from '../workers/workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Inbox | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function InboxPage() {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current="/inbox" />
      <ThemeToggle />
      <NotificationBell standalone />
    </header>
    <section className={styles.section} aria-labelledby="inbox-heading">
      <h1 id="inbox-heading">Answer inbox</h1>
      <p className={styles.muted}>Private questions from applications appear here. Close the panel to return to this page.</p>
    </section>
  </main>;
}
