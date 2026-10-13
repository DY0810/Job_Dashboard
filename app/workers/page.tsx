import { redirect } from 'next/navigation';

/** Workers lives in the settings drawer now; old links land on it. */
export default function WorkersPage() {
  redirect('/applications?settings=1');
}
