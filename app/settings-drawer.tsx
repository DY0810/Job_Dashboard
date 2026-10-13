'use client';

import { Settings as SettingsIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useRef } from 'react';
import { SideDrawer } from './side-drawer';
import Settings from './settings/settings';
import Workers from './workers/workers';
import styles from './workers/workers.module.css';

/** `?settings=1` on the current path. Native pushState: Next syncs useSearchParams without a server round trip. */
export function setSettingsOpen(open: boolean) {
  const url = new URL(window.location.href);
  if (open) url.searchParams.set('settings', '1'); else url.searchParams.delete('settings');
  window.history.pushState(null, '', url);
}

export function SettingsButton() {
  return <button type="button" className="chip app-icon-button" aria-haspopup="dialog" aria-label="Settings" title="Settings"
    onClick={() => setSettingsOpen(true)}>
    <SettingsIcon size={16} aria-hidden="true" />
  </button>;
}

export function SettingsDrawer() {
  const open = useSearchParams().get('settings') === '1';
  // Workers holds closing while a request is unresolved, as it held navigation on its own page.
  const guard = useRef<(() => boolean) | null>(null);
  return <SideDrawer open={open} onClose={() => { if (!guard.current?.()) setSettingsOpen(false); }} title="Settings">
    {open && <div className={styles.page}><Settings><Workers guard={guard} /></Settings></div>}
  </SideDrawer>;
}
