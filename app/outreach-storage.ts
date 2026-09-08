import type { Sender } from '@/lib/outreach';

type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const SENDER_KEY = 'workie-outreach-sender';
const TOKEN_KEY = 'workie-send-token';

function localStore(): LocalStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function senderDraft(store: LocalStore | null = localStore()): Partial<Sender> {
  try {
    const raw: unknown = JSON.parse(store?.getItem(SENDER_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return {};
    const values = raw as Record<string, unknown>;
    return {
      name: typeof values.name === 'string' ? values.name : undefined,
      intro: typeof values.intro === 'string' ? values.intro : undefined,
      from: typeof values.from === 'string' ? values.from : undefined,
    };
  } catch {
    return {};
  }
}

export function readSenderDraft(store?: LocalStore | null): Partial<Sender> {
  return senderDraft(store);
}

export function validSender(value: Partial<Sender>): Sender | null {
  const name = value.name?.trim();
  const intro = value.intro?.trim();
  const from = value.from?.trim();
  return name && intro && from ? { name, intro, from } : null;
}

export function readSenderProfile(store?: LocalStore | null): Sender | null {
  return validSender(senderDraft(store));
}

export function saveSenderProfile(sender: Sender, store: LocalStore | null = localStore()): boolean {
  try {
    store?.setItem(SENDER_KEY, JSON.stringify(sender));
    return Boolean(store);
  } catch {
    return false;
  }
}

export function readSendToken(store: LocalStore | null = localStore()): string | null {
  try {
    return store?.getItem(TOKEN_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function saveSendToken(token: string, store: LocalStore | null = localStore()): boolean {
  try {
    store?.setItem(TOKEN_KEY, token);
    return Boolean(store);
  } catch {
    return false;
  }
}

export function clearSendToken(store: LocalStore | null = localStore()): void {
  try {
    store?.removeItem(TOKEN_KEY);
  } catch {
    // Browser privacy settings can reject storage access; sending must remain usable in memory.
  }
}
