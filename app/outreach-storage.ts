import type { Sender } from '@/lib/outreach';
import { del, get, localStore, set, type Store } from './local-store';

const SENDER_KEY = 'workie-outreach-sender';
const TOKEN_KEY = 'workie-send-token';

export function readSenderDraft(store: Store | null = localStore()): Partial<Sender> {
  try {
    const raw: unknown = JSON.parse(get(SENDER_KEY, store) ?? '{}');
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

export function validSender(value: Partial<Sender>): Sender | null {
  const name = value.name?.trim();
  const intro = value.intro?.trim();
  const from = value.from?.trim();
  return name && intro && from ? { name, intro, from } : null;
}

export function readSenderProfile(store?: Store | null): Sender | null {
  return validSender(readSenderDraft(store));
}

export function saveSenderProfile(sender: Sender, store: Store | null = localStore()): boolean {
  return set(SENDER_KEY, JSON.stringify(sender), store);
}

export function readSendToken(store: Store | null = localStore()): string | null {
  return get(TOKEN_KEY, store)?.trim() || null;
}

export function saveSendToken(token: string, store: Store | null = localStore()): boolean {
  return set(TOKEN_KEY, token, store);
}

/** Browser privacy settings can reject storage; sending must remain usable in memory. */
export function clearSendToken(store: Store | null = localStore()): void {
  del(TOKEN_KEY, store);
}
