import styles from '../workers/workers.module.css';
import { PrivateShell, privateMetadata } from '../private-shell';

export const dynamic = 'force-dynamic';
export const metadata = privateMetadata('Inbox');

export default function InboxPage() {
  return <PrivateShell current="/inbox" styles={styles} switcher={false} standalone>
    <section className={styles.section} aria-labelledby="inbox-heading">
      <h1 id="inbox-heading">Answer inbox</h1>
      <p className={styles.muted}>Private questions from applications appear here. Close the panel to return to this page.</p>
    </section>
  </PrivateShell>;
}
