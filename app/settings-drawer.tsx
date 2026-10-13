'use client';

import { RefreshCw, Settings as SettingsIcon } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useRef } from 'react';
import { Modal } from './modal';
import Settings from './settings/settings';
import Workers from './workers/workers';
import styles from './workers/workers.module.css';

/**
 * `?settings=1` on the current path. Native history: Next syncs useSearchParams without a server round trip.
 * Opening pushes an entry and closing steps back over it, so Back closes an open drawer and never reopens a closed one.
 */
export function setSettingsOpen(open: boolean) {
  if (!open && window.history.state?.workieSettings) return window.history.back();
  const url = new URL(window.location.href);
  if (open) url.searchParams.set('settings', '1'); else url.searchParams.delete('settings');
  if (open) window.history.pushState({ workieSettings: true }, '', url); else window.history.replaceState(null, '', url);
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
  // The modal makes the header inert, so the drawer carries its own refresh.
  const refresh = <button type="button" className="chip app-icon-button" aria-label="Refresh" title="Refresh"
    onClick={() => window.dispatchEvent(new Event('workie:refresh'))}>
    <RefreshCw size={16} aria-hidden="true" />
  </button>;
  return <Modal kind="drawer" open={open} onClose={() => guard.current?.() ? false : setSettingsOpen(false)} title="Settings" actions={refresh}>
    {open && <div className={styles.page}><Settings><Workers guard={guard} /></Settings></div>}
  </Modal>;
}
