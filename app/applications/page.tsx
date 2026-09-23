import type { Metadata } from 'next';
import { NotificationBell } from '../notification-bell';
import { ThemeToggle } from '../theme-toggle';
import { AppNav } from '../app-nav';
import Applications from './applications';
import styles from '../workers/workers.module.css';
import { ApplicantSwitcher } from '../applicant-switcher';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Applications | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function ApplicationsPage() {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current="/applications" />
      <ThemeToggle />
      <NotificationBell />
      <ApplicantSwitcher />
    </header>
    <Applications />
  </main>;
}
