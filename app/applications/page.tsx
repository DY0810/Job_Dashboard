import type { Metadata } from 'next';
import Link from 'next/link';
import { NotificationBell } from '../notification-bell';
import { ThemeToggle } from '../theme-toggle';
import Applications from './applications';
import styles from '../workers/workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Applications | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function ApplicationsPage() {
  return <main id="main-content" className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false}>Workie</Link>
      <nav aria-label="Account">
        <Link href="/" prefetch={false}>Jobs</Link>
        <Link href="/profile" prefetch={false}>Profile</Link>
        <span aria-current="page">Applications</span>
        <Link href="/workers" prefetch={false}>Workers</Link>
        <Link href="/settings" prefetch={false}>Settings</Link>
        <Link href="/sign-in" prefetch={false}>Account</Link>
      </nav>
      <ThemeToggle />
      <NotificationBell />
    </header>
    <Applications />
  </main>;
}
