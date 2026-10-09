import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { AppNav } from './app-nav';
import { ApplicantSwitcher } from './applicant-switcher';
import { NotificationBell } from './notification-bell';
import { ThemeToggle } from './theme-toggle';

/** Private pages are never indexed and never send a referrer. */
export const privateMetadata = (title: string): Metadata => ({
  title: `${title} | Workie`, robots: { index: false, follow: false }, referrer: 'no-referrer',
});

/** The private header lives inside <main>: the skip link and the page tests find it there. */
export function PrivateShell({ current, styles, switcher = true, standalone, children }: {
  current: string; styles: Record<string, string>; switcher?: boolean; standalone?: boolean; children: ReactNode;
}) {
  return <main id="main-content" className={styles.page}>
    <header className={`${styles.header} app-header`}>
      <AppNav current={current} />
      <ThemeToggle />
      <NotificationBell standalone={standalone} />
      {switcher && <ApplicantSwitcher />}
    </header>
    {children}
  </main>;
}
