import type { Metadata } from 'next';
import Link from 'next/link';
import { ThemeToggle } from '../../theme-toggle';
import ImportMarks from './import-marks';
import styles from '../../workers/workers.module.css';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: 'Import browser marks | Workie', robots: { index: false, follow: false }, referrer: 'no-referrer',
};

export default function ImportPage() {
  return <main className={styles.page}>
    <header className={styles.header}>
      <Link href="/" prefetch={false}>Workie</Link>
      <nav aria-label="Account">
        <Link href="/" prefetch={false}>Jobs</Link>
        <Link href="/profile" prefetch={false}>Profile</Link>
        <Link href="/workers" prefetch={false}>Workers</Link>
        <span aria-current="page">Import</span>
      </nav>
      <ThemeToggle />
    </header>
    <ImportMarks />
  </main>;
}
