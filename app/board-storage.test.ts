import { describe, expect, it } from 'vitest';
import { cleared, href, parseParams, toggleFilter, withPage, withTab } from '../lib/params';
import {
  appliedKey,
  defaultFiltersHref,
  readApplied,
  readDefaultFilters,
  saveApplied,
  saveDefaultFilters,
} from './board-storage';

function store() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('personal board state', () => {
  it('persists checked and unchecked applications independently by stable posting ID', () => {
    const storage = store();
    expect(readApplied(12, storage)).toBe(false);
    expect(saveApplied(12, true, storage)).toBe(true);
    expect(readApplied(12, storage)).toBe(true);
    expect(readApplied(13, storage)).toBe(false);
    expect(saveApplied(12, false, storage)).toBe(true);
    expect(readApplied(12, storage)).toBe(false);
    storage.setItem(appliedKey(12), 'invalid');
    expect(readApplied(12, storage)).toBe(false);
  });

  it('reports storage failure instead of claiming a preference or checkmark was saved', () => {
    const unavailable = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(readApplied(1, unavailable)).toBe(false);
    expect(readDefaultFilters(unavailable)).toBeNull();
    expect(saveApplied(1, true, unavailable)).toBe(false);
    expect(saveDefaultFilters(parseParams({ pay: 'paid' }), unavailable)).toBe(false);
    expect(saveApplied(1, true, null)).toBe(false);
  });

  it('restores entry, junior, mid and paid without stealing the tab, split, or drawer', () => {
    const storage = store();
    const chosen = parseParams({ pay: 'paid', level: 'entry,junior,mid', job: '12', page: '3' });
    expect(saveDefaultFilters(chosen, storage)).toBe(true);
    const saved = readDefaultFilters(storage);
    expect(defaultFiltersHref(parseParams({ tab: 'engineering', job: '5' }), saved))
      .toBe('/?tab=engineering&pay=paid&level=entry%2Cjunior%2Cmid&job=5');
    expect(defaultFiltersHref(parseParams({ basis: 'freelance' }), saved))
      .toBe('/?basis=freelance&pay=paid&level=entry%2Cjunior%2Cmid');
    expect(defaultFiltersHref(parseParams({}), null)).toBeNull();
  });

  it('lets explicit URLs and clear override defaults, including after navigation or reload', () => {
    const saved = 'pay=paid&level=entry%2Cjunior%2Cmid';
    expect(defaultFiltersHref(parseParams({ level: 'senior+' }), saved)).toBeNull();
    expect(defaultFiltersHref(parseParams({ pay: '' }), saved)).toBeNull();
    expect(defaultFiltersHref(parseParams({ page: '2' }), saved)).toBeNull();
    const clear = parseParams(Object.fromEntries(new URL(`http://local${cleared(parseParams({ pay: 'paid' }))}`).searchParams));
    expect(clear.unfiltered).toBe(true);
    expect(defaultFiltersHref(clear, saved)).toBeNull();
    expect(withTab(clear, 'engineering')).toBe('/?tab=engineering&filters=all');
    expect(withPage(clear, 2)).toBe('/?filters=all&page=2');
    expect(toggleFilter(parseParams({ pay: 'paid' }), 'pay', 'paid')).toBe('/?filters=all');
    expect(href(parseParams({ filters: 'all' }))).toBe('/?filters=all');
  });

  it('validates stored filters and cannot turn storage into an external redirect', () => {
    expect(defaultFiltersHref(parseParams({}), 'tab=evil&job=9&pay=paid&level=principal'))
      .toBe('/?pay=paid');
    expect(defaultFiltersHref(parseParams({}), 'https://evil.test')).toBeNull();
    const storage = store();
    expect(saveDefaultFilters(parseParams({}), storage)).toBe(true);
    expect(readDefaultFilters(storage)).toBe('');
  });
});
