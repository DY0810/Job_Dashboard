import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeToggle } from '../theme-toggle';
import Workers from './workers';
import { NotificationBell } from '../notification-bell';
import styles from './workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Workers | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function WorkersPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false}>Workie</Link>
      <nav aria-label="Account">
        <Link href="/" prefetch={false}>Jobs</Link>
        <Link href="/profile" prefetch={false}>Profile</Link>
        <span aria-current="page">Workers</span>
        <Link href="/sign-in" prefetch={false}>Account</Link>
      </nav>
      <ThemeToggle />
      <NotificationBell />
    </header>
    <Workers />
  </main>;
}
