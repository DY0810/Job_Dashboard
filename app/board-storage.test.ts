import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleared, href, parseParams, toggleFilter, withPage, withTab } from '../lib/params';
import {
  activeOwner,
  appliedKey,
  defaultFiltersHref,
  myFilter,
  readApplied,
  readDefaultFilters,
  saveApplied,
  saveDefaultFilters,
  savedFilterQuery,
  stillEngaged,
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
  afterEach(() => { vi.unstubAllGlobals(); });

  it('retries a failed applicant lookup and only treats 401 as signed out', async () => {
    const responses = [new Response(null, { status: 503 }), new Response(null, { status: 401 })];
    const request = vi.fn(async () => responses.shift()!);
    vi.stubGlobal('fetch', request);
    await expect(activeOwner()).rejects.toThrow('503');
    expect(await activeOwner()).toBeNull();
    expect(await activeOwner()).toBeNull(); // signed out is cached for the page
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('persists checked and unchecked applications independently by stable posting ID', () => {
    const storage = store();
    expect(readApplied(12, null, storage)).toBe(false);
    expect(saveApplied(12, true, null, storage)).toBe(true);
    expect(readApplied(12, null, storage)).toBe(true);
    expect(readApplied(13, null, storage)).toBe(false);
    expect(saveApplied(12, false, null, storage)).toBe(true);
    expect(readApplied(12, null, storage)).toBe(false);
    storage.setItem(appliedKey(12), 'invalid');
    expect(readApplied(12, null, storage)).toBe(false);
    expect(saveApplied(12, true, 'dy', storage)).toBe(true);
    expect(readApplied(12, 'dy', storage)).toBe(true);
    expect(readApplied(12, 'may', storage)).toBe(false);
    expect(readApplied(12, null, storage)).toBe(false);
  });

  it('reports storage failure instead of claiming a preference or checkmark was saved', () => {
    const unavailable = {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('full'); },
      removeItem: () => { throw new Error('blocked'); },
    };
    expect(readApplied(1, null, unavailable)).toBe(false);
    expect(readDefaultFilters(unavailable)).toBeNull();
    expect(saveApplied(1, true, null, unavailable)).toBe(false);
    expect(saveDefaultFilters(parseParams({ pay: 'paid' }), unavailable)).toBe(false);
    expect(saveApplied(1, true, null, null)).toBe(false);
  });

  it('restores entry, junior, mid and paid-or-unknown without stealing the tab, split, or drawer', () => {
    const storage = store();
    const chosen = parseParams({ pay: 'paid,unknown', level: 'entry,junior,mid', job: '12', page: '3' });
    expect(saveDefaultFilters(chosen, storage)).toBe(true);
    const saved = readDefaultFilters(storage);
    expect(defaultFiltersHref(parseParams({ tab: 'engineering', job: '5' }), saved))
      .toBe('/?tab=engineering&pay=paid%2Cunknown&level=entry%2Cjunior%2Cmid&job=5');
    expect(defaultFiltersHref(parseParams({ basis: 'freelance' }), saved))
      .toBe('/?basis=freelance&pay=paid%2Cunknown&level=entry%2Cjunior%2Cmid');
    expect(defaultFiltersHref(parseParams({}), null)).toBeNull();
    expect(defaultFiltersHref(parseParams({ level: 'senior+', job: '5' }), saved, true))
      .toBe('/?pay=paid%2Cunknown&level=entry%2Cjunior%2Cmid');
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

  it('runs the one filter button: setup, save, toggle off, toggle on, change, save', () => {
    const paid = 'pay=paid';
    const both = 'pay=paid&level=entry';
    // Nothing saved: one click to start, a second to save what is chosen, and nothing to save is inert.
    expect(myFilter({ saved: '', live: '', engaged: false, setup: false })).toEqual({ label: 'my filter', action: 'setup' });
    expect(myFilter({ saved: '', live: '', engaged: false, setup: true })).toEqual({ label: 'save filter', action: 'none' });
    expect(myFilter({ saved: '', live: paid, engaged: false, setup: true })).toEqual({ label: 'save filter', action: 'save' });
    // Saved and showing: pressed, and a click turns it off.
    expect(myFilter({ saved: paid, live: paid, engaged: true, setup: false })).toEqual({ label: 'my filter', pressed: true, action: 'clear' });
    // Off, or another filter that never came from it: a click applies it.
    expect(myFilter({ saved: paid, live: '', engaged: false, setup: false })).toEqual({ label: 'my filter', pressed: false, action: 'apply' });
    expect(myFilter({ saved: paid, live: both, engaged: false, setup: false }).action).toBe('apply');
    // Changed while on: offer to save the change.
    expect(myFilter({ saved: paid, live: both, engaged: true, setup: false })).toEqual({ label: 'save filter', action: 'save' });

    expect(stillEngaged(false, paid, paid)).toBe(true);
    expect(stillEngaged(true, paid, both)).toBe(true);
    expect(stillEngaged(false, paid, both)).toBe(false);
    expect(stillEngaged(true, paid, '')).toBe(false);
    expect(stillEngaged(true, '', both)).toBe(false);
  });

  it('compares the saved filter as it applies on the current tab', () => {
    const storage = store();
    saveDefaultFilters(parseParams({ tab: 'engineering', level: 'junior,entry', season: 'summer', job: '4', page: '2' }), storage);
    const saved = readDefaultFilters(storage);
    expect(savedFilterQuery(parseParams({ tab: 'engineering' }), saved)).toBe('season=summer&level=entry%2Cjunior');
    // Design has no season vocabulary, so only the level survives there.
    expect(savedFilterQuery(parseParams({}), saved)).toBe('level=entry%2Cjunior');
    expect(savedFilterQuery(parseParams({}), null)).toBe('');
  });
});
