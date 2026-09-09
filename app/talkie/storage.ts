type LocalStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const DRAFTS_KEY = 'talkie-drafts-v1';
const TOKEN_KEY = 'talkie-token';
const AUTHOR_KEY = 'talkie-author';

export type NewNoteDraft = {
  week: string;
  clientKey: string;
  body: string;
  x: number;
  y: number;
  w: number;
  h: number;
};

type DraftState = { newNote: NewNoteDraft | null; edits: Record<string, string> };

function localStore(): LocalStore | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    return null;
  }
}

function validNewDraft(value: unknown): NewNoteDraft | null {
  if (!value || typeof value !== 'object') return null;
  const draft = value as Record<string, unknown>;
  if (
    typeof draft.week !== 'string' ||
    typeof draft.clientKey !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(draft.clientKey) ||
    typeof draft.body !== 'string'
  ) {
    return null;
  }
  const geometry = ['x', 'y', 'w', 'h'] as const;
  if (geometry.some((key) => typeof draft[key] !== 'number' || !Number.isInteger(draft[key]))) return null;
  return {
    week: draft.week,
    clientKey: draft.clientKey,
    body: draft.body,
    x: draft.x as number,
    y: draft.y as number,
    w: draft.w as number,
    h: draft.h as number,
  };
}

function readState(store: LocalStore | null = localStore()): DraftState {
  try {
    const raw: unknown = JSON.parse(store?.getItem(DRAFTS_KEY) ?? '{}');
    if (!raw || typeof raw !== 'object') return { newNote: null, edits: {} };
    const value = raw as Record<string, unknown>;
    const edits: Record<string, string> = {};
    if (value.edits && typeof value.edits === 'object') {
      for (const [id, body] of Object.entries(value.edits as Record<string, unknown>)) {
        if (/^\d+$/.test(id) && typeof body === 'string') edits[id] = body;
      }
    }
    return { newNote: validNewDraft(value.newNote), edits };
  } catch {
    return { newNote: null, edits: {} };
  }
}

function writeState(state: DraftState, store: LocalStore | null = localStore()): boolean {
  try {
    store?.setItem(DRAFTS_KEY, JSON.stringify(state));
    return Boolean(store);
  } catch {
    return false;
  }
}

export function readNewNoteDraft(week: string, store?: LocalStore | null): NewNoteDraft | null {
  const draft = readState(store).newNote;
  return draft?.week === week ? draft : null;
}

export function saveNewNoteDraft(draft: NewNoteDraft, store?: LocalStore | null): boolean {
  const state = readState(store);
  return writeState({ ...state, newNote: draft }, store);
}

export function clearNewNoteDraft(clientKey: string, store?: LocalStore | null): void {
  const state = readState(store);
  if (state.newNote?.clientKey !== clientKey) return;
  void writeState({ ...state, newNote: null }, store);
}

export function readEditDraft(noteId: number, store?: LocalStore | null): string | null {
  return readState(store).edits[String(noteId)] ?? null;
}

export function saveEditDraft(noteId: number, body: string, store?: LocalStore | null): boolean {
  const state = readState(store);
  return writeState({ ...state, edits: { ...state.edits, [noteId]: body } }, store);
}

export function clearEditDraft(noteId: number, store?: LocalStore | null): void {
  const state = readState(store);
  const key = String(noteId);
  if (!(key in state.edits)) return;
  const edits = { ...state.edits };
  delete edits[key];
  void writeState({ ...state, edits }, store);
}

export function readTalkieToken(store: LocalStore | null = localStore()): string | null {
  try {
    return store?.getItem(TOKEN_KEY)?.trim() || null;
  } catch {
    return null;
  }
}

export function saveTalkieToken(token: string, store: LocalStore | null = localStore()): boolean {
  try {
    store?.setItem(TOKEN_KEY, token);
    return Boolean(store);
  } catch {
    return false;
  }
}

export function clearTalkieToken(store: LocalStore | null = localStore()): void {
  try {
    store?.removeItem(TOKEN_KEY);
  } catch {
    // Storage restrictions should not prevent an in-memory token from being used.
  }
}

export function readTalkieAuthor(store: LocalStore | null = localStore()): string {
  try {
    return store?.getItem(AUTHOR_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveTalkieAuthor(author: string, store: LocalStore | null = localStore()): boolean {
  try {
    store?.setItem(AUTHOR_KEY, author);
    return Boolean(store);
  } catch {
    return false;
  }
}
