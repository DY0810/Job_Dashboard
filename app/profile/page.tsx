import type { Metadata } from 'next';
import ProfileEditor from './profile-editor';
import { AppNav } from '../app-nav';
import { ThemeToggle } from '../theme-toggle';
import styles from './profile.module.css';
import { NotificationBell } from '../notification-bell';
import { ApplicantSwitcher } from '../applicant-switcher';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Profile | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function ProfilePage() {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current="/profile" />
      <ThemeToggle />
      <NotificationBell />
      <ApplicantSwitcher />
    </header>
    <ProfileEditor />
  </main>;
}
