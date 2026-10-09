export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** Resolved per call: these modules also run during SSR, and Safari can throw on access. */
export function localStore(): Store | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

/** Storage errors read as absent. */
export function get(key: string, store: Store | null = localStore()): string | null {
  try {
    return store?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

/** False when storage is missing or refuses the write, so callers can warn. */
export function set(key: string, value: string, store: Store | null = localStore()): boolean {
  try {
    if (!store) return false;
    store.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function del(key: string, store: Store | null = localStore()): boolean {
  try {
    if (!store) return false;
    store.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
