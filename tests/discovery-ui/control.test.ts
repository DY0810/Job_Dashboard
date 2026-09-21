import { expect, test } from 'vitest';
import { readLegacyMarks, safePostingUrl } from '../../app/applications/import/control';

function storage(entries: [string, string][]) {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    key: (index: number) => [...values.keys()][index] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
  };
}

test('legacy enumeration reads only canonical positive safe numeric flags equal to 1', () => {
  const store = storage([
    ['workie-applied:1', '1'], ['workie-applied:999999', '1'], ['workie-applied:2', '0'],
    ['workie-applied:3', 'true'], ['workie-applied:0', '1'], ['workie-applied:-1', '1'],
    ['workie-applied:01', '1'], ['workie-applied:9007199254740992', '1'], ['other', '1'],
  ]);
  expect(readLegacyMarks(store)).toEqual({ postingIds: [1, 999999], overflow: false });
  expect(store.getItem('workie-applied:1')).toBe('1');
});

test('exactly 1000 marks fit; overflow is explicit and never submits a partial preview', () => {
  const entries: [string, string][] = Array.from({ length: 1000 }, (_, i) => [`workie-applied:${i + 1}`, '1']);
  expect(readLegacyMarks(storage(entries)).postingIds).toHaveLength(1000);
  expect(readLegacyMarks(storage([...entries, ['workie-applied:1001', '1']]))).toEqual({
    postingIds: [], overflow: true,
  });
});

test('storage denial is not mistaken for an empty browser', () => {
  expect(() => readLegacyMarks({ length: 1, key() { throw new Error('Denied'); }, getItem: () => '1' })).toThrow();
});

test('posting navigation accepts only absolute http or https without embedded credentials', () => {
  expect(safePostingUrl('https://jobs.example.test/role/1')).toBe('https://jobs.example.test/role/1');
  for (const url of [null, 'javascript:alert(1)', 'data:text/html,hello', '//jobs.example.test', '/role/1',
    'https://user:password@jobs.example.test', 'file:///tmp/private',
    'https:jobs.example.test', ' https://jobs.example.test', 'https://jobs.example.test/\nsecret']) expect(safePostingUrl(url)).toBeNull();
});
