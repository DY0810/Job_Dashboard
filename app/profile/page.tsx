import ProfileEditor from './profile-editor';
import styles from './profile.module.css';
import { PrivateShell, privateMetadata } from '../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Profile');

export default function ProfilePage() {
  return <PrivateShell current="/profile" styles={styles}><ProfileEditor /></PrivateShell>;
}
