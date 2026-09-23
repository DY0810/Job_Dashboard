import type { Metadata } from 'next';
import { ThemeToggle } from '../theme-toggle';
import { AppNav } from '../app-nav';
import Workers from './workers';
import { NotificationBell } from '../notification-bell';
import styles from './workers.module.css';
import { ApplicantSwitcher } from '../applicant-switcher';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Workers | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function WorkersPage() {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current="/workers" />
      <ThemeToggle />
      <NotificationBell />
      <ApplicantSwitcher />
    </header>
    <Workers />
  </main>;
}
