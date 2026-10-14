import Emails from './emails';
import styles from '../workers/workers.module.css';
import { PrivateShell, privateMetadata } from '../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Emails');

export default function EmailsPage() {
  return <PrivateShell current="/emails" styles={styles}><Emails /></PrivateShell>;
}
