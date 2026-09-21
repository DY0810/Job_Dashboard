import type { Metadata } from 'next';
import Link from 'next/link';
import ProfileEditor from './profile-editor';
import styles from './profile.module.css';
import { NotificationBell } from '../notification-bell';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Profile | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function ProfilePage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false}>Workie</Link>
      <nav aria-label="Account">
        <Link href="/" prefetch={false}>Jobs</Link>
        <span aria-current="page">Profile</span>
        <Link href="/sign-in" prefetch={false}>Account</Link>
      </nav>
      <NotificationBell />
    </header>
    <ProfileEditor />
  </main>;
}
