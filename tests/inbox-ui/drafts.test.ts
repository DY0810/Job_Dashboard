import { expect, it } from 'vitest';
import { DraftVault, unlockDraftKey } from '../../lib/profile-drafts';

function memory(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; }, key: (i) => [...values.keys()][i] ?? null,
    getItem: (key) => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); }, clear: () => values.clear(),
  };
}

it('isolates inbox and profile ciphertext even after moving it between storage slots', async () => {
  const storage = memory();
  const key = await unlockDraftKey(btoa('s'.repeat(32)));
  const profile = new DraftVault(storage, 'synthetic-owner', 1, '1', key);
  const inbox = new DraftVault(storage, 'synthetic-owner', 1, '1', key, undefined, undefined, 'inbox');
  await profile.save({ revision: 0, desired: 'profile-only' });
  await inbox.save({ revision: 0, desired: 'inbox-only' });
  expect(inbox.slots()).toEqual([inbox.slot]);
  expect(profile.slots()).toEqual([profile.slot]);
  const saved = storage.getItem(inbox.slot)!;
  expect(saved).not.toContain('inbox-only');
  storage.setItem(inbox.slot, storage.getItem(profile.slot)!);
  await expect(inbox.read(inbox.slot)).rejects.toThrow();
  storage.setItem(profile.slot, saved);
  await expect(profile.read(profile.slot)).rejects.toThrow();
});

it('recovers encrypted latest edits and exact pending IDs after reload, never under another owner or rotated key', async () => {
  const storage = memory();
  const key = await unlockDraftKey(btoa('s'.repeat(32)));
  const vault = new DraftVault(storage, 'synthetic-owner-a', 1, '1', key, undefined, undefined, 'inbox');
  const snapshot = { revision: 1, latest: 'newer private text', pendingRequestId: crypto.randomUUID(), sent: 'original private text' };
  await vault.save(snapshot);
  const slot = vault.slot;
  vault.dispose();
  const reload = new DraftVault(storage, 'synthetic-owner-a', 1, '1', key, undefined, undefined, 'inbox');
  expect(await reload.read(slot)).toEqual(snapshot);
  const other = new DraftVault(storage, 'synthetic-owner-b', 1, '1', key, undefined, undefined, 'inbox');
  expect(other.slots()).toHaveLength(0);
  await expect(other.read(slot)).rejects.toThrow();
  const rotated = new DraftVault(storage, 'synthetic-owner-a', 1, '2', await unlockDraftKey(btoa('r'.repeat(32))), undefined, undefined, 'inbox');
  await expect(rotated.read(slot)).rejects.toThrow();
  expect(storage.getItem(slot)).not.toBeNull();
  await rotated.save(snapshot);
  expect(await rotated.read(rotated.slot)).toEqual(snapshot);
});
