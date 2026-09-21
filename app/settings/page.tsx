import type { Metadata } from 'next';
import Link from 'next/link';
import { NotificationBell } from '../notification-bell';
import { ThemeToggle } from '../theme-toggle';
import Settings from './settings';
import styles from '../workers/workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Settings | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function SettingsPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false}>Workie</Link>
      <nav aria-label="Account">
        <Link href="/" prefetch={false}>Jobs</Link>
        <Link href="/profile" prefetch={false}>Profile</Link>
        <Link href="/applications" prefetch={false}>Applications</Link>
        <Link href="/workers" prefetch={false}>Workers</Link>
        <span aria-current="page">Settings</span>
        <Link href="/sign-in" prefetch={false}>Account</Link>
      </nav>
      <ThemeToggle />
      <NotificationBell />
    </header>
    <Settings />
  </main>;
}
