import Link from 'next/link';
import { Suspense } from 'react';
import { AppNav } from './app-nav';
import { ApplicantSwitcher } from './applicant-switcher';
import { RefreshButton } from './refresh-button';
import { SettingsButton, SettingsDrawer } from './settings-drawer';
import { SideCollapse, SideEdgeToggle, SideOpen, SideScrim } from './side-controls';

/**
 * The one sidebar every page wears, laid out like Postie's: wordmark and collapse on top, the
 * page's one action, the destinations, and the applicant with settings at the foot. It is fixed
 * to the left and the body is padded by its width, so no page had to change its own layout.
 * Rendered on the server so the hosted flag is the server's; where it renders on the client
 * (the error page) the flag is unknown and the refresh button asks the server.
 */
export function AppHeader({ current, switcher = true }: { current: string; switcher?: boolean }) {
  return <>
    <div className="mobile-top">
      <SideOpen />
      <Link href="/" className="logo" prefetch={false}><span className="word">Workie</span></Link>
    </div>
    <aside className="side app-header" id="side" aria-label="Sidebar">
      <div className="side-top">
        <Link href="/" className="logo" aria-label="Workie home" prefetch={false}><span className="word">Workie</span></Link>
        <div className="side-actions"><SideCollapse /></div>
      </div>
      <RefreshButton hosted={typeof window === 'undefined' ? Boolean(process.env.VERCEL) : undefined} />
      <AppNav current={current} />
      <div className="side-foot">
        {switcher && <ApplicantSwitcher />}
        <SettingsButton />
      </div>
      <SideEdgeToggle />
    </aside>
    <SideScrim />
    <Suspense fallback={null}><SettingsDrawer /></Suspense>
  </>;
}
