import Settings from './settings';
import styles from '../workers/workers.module.css';
import { PrivateShell, privateMetadata } from '../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Settings');

export default function SettingsPage() {
  return <PrivateShell current="/settings" styles={styles}><Settings /></PrivateShell>;
}
