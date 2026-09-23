import type { Metadata } from 'next';
import { ThemeToggle } from '../../theme-toggle';
import { AppNav } from '../../app-nav';
import ImportMarks from './import-marks';
import { NotificationBell } from '../../notification-bell';
import styles from '../../workers/workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Import browser marks | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function ImportPage() {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current="/applications" />
      <ThemeToggle />
      <NotificationBell />
    </header>
    <ImportMarks />
  </main>;
}
