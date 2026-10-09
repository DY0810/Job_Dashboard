import ImportMarks from './import-marks';
import styles from '../../workers/workers.module.css';
import { PrivateShell, privateMetadata } from '../../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Import browser marks');

export default function ImportPage() {
  return <PrivateShell current="/applications" styles={styles} switcher={false}><ImportMarks /></PrivateShell>;
}
