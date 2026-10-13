import { redirect } from 'next/navigation';

/** Settings is a drawer now; old links land on it. */
export default function SettingsPage() {
  redirect('/applications?settings=1');
}
