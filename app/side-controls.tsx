'use client';

import { useEffect, useSyncExternalStore } from 'react';
import { Menu, PanelLeft } from 'lucide-react';

/**
 * The sidebar's two states live on <html> as data attributes, like Postie's body classes:
 * `data-side="rail"` (collapsed, remembered) and `data-side-open` (slid in on a phone).
 * The boot script in layout.tsx applies a remembered rail before paint.
 */
type Key = 'side' | 'sideOpen';
const EVENT = 'workie:side';
const subscribe = (change: () => void) => {
  window.addEventListener(EVENT, change);
  return () => window.removeEventListener(EVENT, change);
};
const useSide = (key: Key) =>
  useSyncExternalStore(subscribe, () => document.documentElement.dataset[key] ?? '', () => '');

function setSide(key: Key, value: string) {
  const data = document.documentElement.dataset;
  if (value) data[key] = value; else delete data[key];
  window.dispatchEvent(new Event(EVENT));
}

/** Desktop: collapses the sidebar to an icon rail and back. */
export function SideCollapse() {
  const rail = useSide('side') === 'rail';
  const label = rail ? 'Expand sidebar' : 'Collapse sidebar';
  return <button type="button" className="icon-btn side-collapse" aria-label={label} title={label} aria-expanded={!rail} aria-controls="side"
    onClick={() => {
      setSide('side', rail ? '' : 'rail');
      try { localStorage.setItem('workie-side', rail ? 'open' : 'rail'); } catch {}
    }}>
    <PanelLeft size={18} strokeWidth={1.75} aria-hidden="true" />
  </button>;
}

/** Phone: the menu button that slides the sidebar in. */
export function SideOpen() {
  const open = useSide('sideOpen') === '1';
  return <button type="button" className="icon-btn menu-btn" aria-label="Open sidebar" aria-expanded={open} aria-controls="side"
    onClick={() => setSide('sideOpen', '1')}>
    <Menu size={18} strokeWidth={1.75} aria-hidden="true" />
  </button>;
}

/** Phone: the dim layer behind the open sidebar. A tap on it, Esc, or following a link closes the sidebar. */
export function SideScrim() {
  const open = useSide('sideOpen') === '1';
  useEffect(() => {
    if (!open) return;
    const close = () => setSide('sideOpen', '');
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); };
    const onClick = (event: MouseEvent) => { if ((event.target as Element).closest('#side a')) close(); };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => { document.removeEventListener('keydown', onKey); document.removeEventListener('click', onClick); };
  }, [open]);
  return <div className="side-scrim" aria-hidden="true" onClick={() => setSide('sideOpen', '')} />;
}
