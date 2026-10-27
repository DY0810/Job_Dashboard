'use client';

import { useEffect, useRef, useSyncExternalStore } from 'react';
import { Menu, PanelLeft } from 'lucide-react';

/**
 * The sidebar's two states live on <html> as data attributes, like Postie's body classes:
 * `data-side="rail"` (collapsed, remembered) and `data-side-open` (slid in on a phone).
 * Its dragged width is `--side` on <html>'s style, and `data-side-drag` marks a drag in progress.
 * The boot script in layout.tsx applies a remembered rail and width before paint.
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

/** The width limits; layout.tsx's boot script repeats them when it restores a saved width. */
const MIN = 200, MAX = 400;
/** Arrow keys move the edge 16px; Home and End clamp to the limits. */
const KEYS: Record<string, number> = { ArrowLeft: -16, ArrowRight: 16, Home: -Infinity, End: Infinity };
const sideWidth = () => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--side'));
const resize = (width: number) => {
  document.documentElement.style.setProperty('--side', `${Math.min(MAX, Math.max(MIN, Math.round(width)))}px`);
  window.dispatchEvent(new Event(EVENT));
};
const save = () => { try { localStorage.setItem('workie-side-width', String(sideWidth())); } catch {} };

/** Desktop: the sidebar's right edge. Drag it, or focus it and press the arrow keys, to set `--side`. */
export function SideResize() {
  const width = useSyncExternalStore(subscribe, sideWidth, () => undefined);
  const grab = useRef(0); // pointer's distance from the edge, so the edge doesn't jump to the pointer
  const root = () => document.documentElement.dataset;
  return <div role="separator" tabIndex={0} className="side-resize" aria-label="Resize sidebar" aria-orientation="vertical"
    aria-controls="side" aria-valuemin={MIN} aria-valuemax={MAX} aria-valuenow={width}
    onPointerDown={(event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      grab.current = event.clientX - sideWidth();
      root().sideDrag = '1';
    }}
    onPointerMove={(event) => { if (event.currentTarget.hasPointerCapture(event.pointerId)) resize(event.clientX - grab.current); }}
    onLostPointerCapture={() => { delete root().sideDrag; save(); }}
    onKeyDown={(event) => {
      if (!(event.key in KEYS)) return;
      event.preventDefault();
      resize(sideWidth() + KEYS[event.key]);
      save();
    }} />;
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
