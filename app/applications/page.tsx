import Applications from './applications';
import styles from '../workers/workers.module.css';
import { PrivateShell, privateMetadata } from '../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Applications');

export default function ApplicationsPage() {
  return <PrivateShell current="/applications" styles={styles}><Applications /></PrivateShell>;
}
