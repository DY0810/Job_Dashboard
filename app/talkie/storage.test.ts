import { describe, expect, it } from 'vitest';

import {
  clearEditDraft,
  clearNewNoteDraft,
  clearTalkieToken,
  readEditDraft,
  readNewNoteDraft,
  readTalkieToken,
  saveEditDraft,
  saveNewNoteDraft,
  saveTalkieToken,
} from './storage.ts';

function store(values: Record<string, string> = {}) {
  const valuesByKey = new Map(Object.entries(values));
  return {
    getItem: (key: string) => valuesByKey.get(key) ?? null,
    setItem: (key: string, value: string) => valuesByKey.set(key, value),
    removeItem: (key: string) => valuesByKey.delete(key),
  };
}

const DRAFT = {
  week: '2026-W37',
  clientKey: '8b64ed75-4c6f-49f2-8e8a-958489279491',
  body: 'do not lose this',
  x: 10,
  y: 20,
  w: 180,
  h: 0,
};

describe('Talkie local recovery', () => {
  it('keeps a new note and edit draft across a reload-shaped read', () => {
    const saved = store();
    expect(saveNewNoteDraft(DRAFT, saved)).toBe(true);
    expect(saveEditDraft(42, 'edited but not yet confirmed', saved)).toBe(true);
    expect(readNewNoteDraft('2026-W37', saved)).toEqual(DRAFT);
    expect(readEditDraft(42, saved)).toBe('edited but not yet confirmed');

    clearNewNoteDraft(DRAFT.clientKey, saved);
    clearEditDraft(42, saved);
    expect(readNewNoteDraft('2026-W37', saved)).toBeNull();
    expect(readEditDraft(42, saved)).toBeNull();
  });

  it('does not clear a newer new-note draft by an older request', () => {
    const saved = store();
    saveNewNoteDraft(DRAFT, saved);
    clearNewNoteDraft('4f0e93df-54d5-4b58-a0e0-9c0c9f10414a', saved);
    expect(readNewNoteDraft('2026-W37', saved)).toEqual(DRAFT);
  });

  it('does not resurrect a previous-week new-note draft', () => {
    const saved = store();
    saveNewNoteDraft(DRAFT, saved);
    expect(readNewNoteDraft('2026-W38', saved)).toBeNull();
    expect(readNewNoteDraft('2026-W37', saved)).toEqual(DRAFT);
  });

  it('keeps storage failures from blocking token and draft behavior', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(saveNewNoteDraft(DRAFT, blocked)).toBe(false);
    expect(readNewNoteDraft('2026-W37', blocked)).toBeNull();
    expect(saveTalkieToken('token', blocked)).toBe(false);
    expect(readTalkieToken(blocked)).toBeNull();
    expect(() => clearTalkieToken(blocked)).not.toThrow();
  });
});
