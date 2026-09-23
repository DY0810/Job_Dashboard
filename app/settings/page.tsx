import type { Metadata } from 'next';
import { NotificationBell } from '../notification-bell';
import { ThemeToggle } from '../theme-toggle';
import { AppNav } from '../app-nav';
import Settings from './settings';
import styles from '../workers/workers.module.css';
import { ApplicantSwitcher } from '../applicant-switcher';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Settings | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function SettingsPage() {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current="/settings" />
      <ThemeToggle />
      <NotificationBell />
      <ApplicantSwitcher />
    </header>
    <Settings />
  </main>;
}
