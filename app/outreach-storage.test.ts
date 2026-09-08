import { describe, expect, it } from 'vitest';

import {
  clearSendToken,
  readSendToken,
  readSenderDraft,
  readSenderProfile,
  saveSendToken,
  saveSenderProfile,
  validSender,
} from './outreach-storage.ts';

function store(values: Record<string, string> = {}) {
  const valuesByKey = new Map(Object.entries(values));
  return {
    getItem: (key: string) => valuesByKey.get(key) ?? null,
    setItem: (key: string, value: string) => valuesByKey.set(key, value),
    removeItem: (key: string) => valuesByKey.delete(key),
  };
}

describe('outreach local storage', () => {
  it('keeps existing valid sender profiles compatible and trims them when used', () => {
    const saved = store({
      'workie-outreach-sender': JSON.stringify({
        name: ' A Person ',
        intro: ' I build things. ',
        from: ' person@example.test ',
      }),
    });

    expect(readSenderProfile(saved)).toEqual({
      name: 'A Person',
      intro: 'I build things.',
      from: 'person@example.test',
    });
  });

  it('does not treat incomplete or malformed profiles as a sender', () => {
    expect(readSenderProfile(store({ 'workie-outreach-sender': '{nope' }))).toBeNull();
    expect(readSenderProfile(store({ 'workie-outreach-sender': JSON.stringify({ name: 'A' }) }))).toBeNull();
    expect(readSenderDraft(store({ 'workie-outreach-sender': JSON.stringify({ name: 3 }) }))).toEqual({});
    expect(validSender({ name: ' ', intro: 'x', from: 'a@example.test' })).toBeNull();
  });

  it('keeps storage failures from breaking sender or token flows', () => {
    const blocked = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => { throw new Error('blocked'); },
    };

    expect(readSenderProfile(blocked)).toBeNull();
    expect(saveSenderProfile({ name: 'A', intro: 'B', from: 'a@example.test' }, blocked)).toBe(false);
    expect(readSendToken(blocked)).toBeNull();
    expect(saveSendToken('token', blocked)).toBe(false);
    expect(() => clearSendToken(blocked)).not.toThrow();
  });
});
