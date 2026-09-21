import type { Metadata } from 'next';
import Link from 'next/link';
import { NotificationBell } from '../notification-bell';
import { ThemeToggle } from '../theme-toggle';
import styles from '../workers/workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Inbox | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function InboxPage() {
  return <main id="main-content" className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false}>Workie</Link>
      <nav aria-label="Account">
        <Link href="/" prefetch={false}>Jobs</Link>
        <Link href="/profile" prefetch={false}>Profile</Link>
        <Link href="/applications" prefetch={false}>Applications</Link>
        <Link href="/workers" prefetch={false}>Workers</Link>
        <Link href="/settings" prefetch={false}>Settings</Link>
        <span aria-current="page">Inbox</span>
        <Link href="/sign-in" prefetch={false}>Account</Link>
      </nav>
      <ThemeToggle />
      <NotificationBell standalone />
    </header>
    <section className={styles.section} aria-labelledby="inbox-heading">
      <h1 id="inbox-heading">Answer inbox</h1>
      <p className={styles.muted}>Private questions from applications appear here. Close the panel to return to this page.</p>
    </section>
  </main>;
}
