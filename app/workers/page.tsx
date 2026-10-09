import Workers from './workers';
import styles from './workers.module.css';
import { PrivateShell, privateMetadata } from '../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Workers');

export default function WorkersPage() {
  return <PrivateShell current="/workers" styles={styles}><Workers /></PrivateShell>;
}
