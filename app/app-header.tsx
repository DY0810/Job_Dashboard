import { Suspense } from 'react';
import { AppNav } from './app-nav';
import { ApplicantSwitcher } from './applicant-switcher';
import { RefreshButton } from './refresh-button';
import { SettingsButton, SettingsDrawer } from './settings-drawer';
import { ThemeToggle } from './theme-toggle';

/** The one header every page wears. Rendered on the server so the hosted flag is the server's. */
export function AppHeader({ current, switcher = true }: { current: string; switcher?: boolean }) {
  return <>
    <header className="app-header">
      <AppNav current={current} />
      <div className="app-tools">
        <RefreshButton hosted={Boolean(process.env.VERCEL)} />
        <ThemeToggle />
        <SettingsButton />
        {switcher && <ApplicantSwitcher />}
      </div>
    </header>
    <Suspense fallback={null}><SettingsDrawer /></Suspense>
  </>;
}
