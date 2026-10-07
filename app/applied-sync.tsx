'use client';

import { useEffect } from 'react';
import { EXPECTED_APPLICANT_HEADER } from '../lib/applications/applicant-precondition';
import { APPLIED_EVENT, appliedKey } from './board-storage';

const SYNCED = 'workie-applied-synced';
type Store = Pick<Storage, 'length' | 'key' | 'getItem' | 'setItem' | 'removeItem'>;

/**
 * Reports the active applicant's board "applied" checks to their auto-apply, which then never applies
 * to those jobs. It reuses the import preview/confirm endpoints. Server marks are permanent, so
 * unchecking stays in this browser. Checks are stored per applicant because DY and May share a browser.
 * Unscoped checks (signed out, or from before this change) are never reported automatically; the
 * Applications page import can still report them on purpose.
 */
export async function syncApplied(store: Store, request: typeof fetch = fetch, signal?: AbortSignal) {
  const ticked: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key?.startsWith('workie-applied:') && store.getItem(key) === '1') ticked.push(key);
  }
  if (!ticked.length) return 0;
  const init = { credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal } as const;
  const account = await request('/api/auth/applicant', init);
  if (!account.ok) return 0;
  const { ownerId } = await account.json() as { ownerId: string };
  let synced: string[] = [];
  try { synced = JSON.parse(store.getItem(SYNCED) ?? '[]'); } catch { /* resend; confirming a mark twice is harmless */ }
  const prefix = `workie-applied:${ownerId}:`, checked: number[] = [];
  let moved = false;
  for (const key of ticked) {
    // A check from before checks were per applicant moves to the applicant it was already reported to.
    const legacy = /^workie-applied:([1-9]\d*)$/.exec(key)?.[1];
    if (legacy && synced.includes(`${ownerId}:${legacy}`)) {
      store.setItem(appliedKey(Number(legacy), ownerId), '1');
      store.removeItem(key);
      moved = true;
    }
    const id = key.startsWith(prefix) ? key.slice(prefix.length) : '';
    if (/^[1-9]\d*$/.test(id)) checked.push(Number(id));
  }
  // Same-tab storage writes fire no event; tell the rows to re-read.
  if (moved && typeof window !== 'undefined') window.dispatchEvent(new CustomEvent(APPLIED_EVENT));
  const pending = checked.filter((id) => !synced.includes(`${ownerId}:${id}`)).slice(0, 1000);
  if (!pending.length) return 0;
  const post = async (path: string, body: unknown) => {
    const response = await request(path, { ...init, method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', [EXPECTED_APPLICANT_HEADER]: ownerId } });
    if (!response.ok) throw new Error(`${path} ${response.status}`);
    return response.json();
  };
  const preview = await post('/api/applications/import/preview', { requestId: crypto.randomUUID(), postingIds: pending }) as
    { previewToken: string; previewHash: string };
  await post('/api/applications/import/confirm', { requestId: crypto.randomUUID(), previewToken: preview.previewToken,
    previewHash: preview.previewHash, postingIds: pending, confirmOwnership: true });
  store.setItem(SYNCED, JSON.stringify([...synced, ...pending.map((id) => `${ownerId}:${id}`)]));
  return pending.length;
}

/** Syncs once on load, and 5 seconds after a checkbox change so a misclick can be undone first. */
export function AppliedSync() {
  useEffect(() => {
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = (delay: number) => {
      clearTimeout(timer); controller.abort(); controller = new AbortController();
      const { signal } = controller;
      timer = setTimeout(() => {
        try { void syncApplied(window.localStorage, fetch, signal).catch(() => {}); } catch { /* storage unavailable */ }
      }, delay);
    };
    const changed = () => schedule(5000);
    schedule(1000);
    window.addEventListener(APPLIED_EVENT, changed);
    return () => { clearTimeout(timer); controller.abort(); window.removeEventListener(APPLIED_EVENT, changed); };
  }, []);
  return null;
}
