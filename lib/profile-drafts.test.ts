import { describe, expect, it } from 'vitest';
import { DraftVault, ProfileSaveError, RevisionWriter, unlockDraftKey } from './profile-drafts';

const owner = 'synthetic-owner-a';
const rawKey = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
const memory = () => {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    key: (i: number) => [...values.keys()][i] ?? null,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    clear: () => values.clear(),
  };
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

describe('authenticated profile draft recovery', () => {
  it('persists ciphertext only and authenticates owner, schema, revision and key version', async () => {
    const storage = memory();
    const key = await unlockDraftKey(rawKey);
    expect(key.extractable).toBe(false);
    const vault = new DraftVault(storage, owner, 1, '1', key);
    await vault.save({ revision: 7, secret: 'Synthetic Private Name' });
    const saved = storage.getItem(vault.slot)!;
    expect(saved).not.toContain('Synthetic Private Name');
    expect(saved).not.toContain(rawKey);
    expect(await vault.read(vault.slot)).toEqual({ revision: 7, secret: 'Synthetic Private Name' });
    for (const change of [{ ownerId: 'synthetic-owner-b' }, { schemaVersion: 2 }, { baseRevision: 8 }, { keyVersion: 2 }]) {
      storage.setItem(vault.slot, JSON.stringify({ ...JSON.parse(saved), ...change }));
      await expect(vault.read(vault.slot)).rejects.toThrow();
    }
    storage.setItem(vault.slot, saved);
    const other = new DraftVault(storage, 'synthetic-owner-b', 1, '1', key);
    expect(other.slots()).toEqual([]);
    await expect(other.read(vault.slot)).rejects.toThrow();
    const differentKey = await unlockDraftKey(btoa('b'.repeat(32)));
    await expect(new DraftVault(storage, owner, 1, '1', differentKey).read(vault.slot)).rejects.toThrow();
  });

  it('does not let late encryption replace the last keystroke or write after principal disposal', async () => {
    const storage = memory();
    const key = await unlockDraftKey(rawKey);
    const holds: ReturnType<typeof deferred<ArrayBuffer>>[] = [];
    const seal = () => { const hold = deferred<ArrayBuffer>(); holds.push(hold); return hold.promise; };
    const vault = new DraftVault(storage, owner, 1, '1', key, undefined, seal);
    const first = vault.save({ revision: 0, name: 'first' });
    const last = vault.save({ revision: 0, name: 'last' });
    expect(vault.pending).toBe(true);
    holds[1].resolve(new Uint8Array([2]).buffer);
    await last;
    const latest = storage.getItem(vault.slot);
    holds[0].resolve(new Uint8Array([1]).buffer);
    await first;
    expect(storage.getItem(vault.slot)).toBe(latest);
    expect(vault.pending).toBe(false);
    const disposed = vault.save({ revision: 0, name: 'must not persist' });
    vault.dispose();
    holds[2].resolve(new Uint8Array([3]).buffer);
    await disposed;
    expect(storage.getItem(vault.slot)).toBe(latest);
  });
});

describe('revision writer', () => {
  it('rebases server fact versions without losing newer edits', async () => {
    const first = deferred<{ revision: number; profile: { id: string; version: number; value: string } }>();
    const requests: { profile: { id: string; version: number; value: string } }[] = [];
    const writer = new RevisionWriter({ revision: 1, profile: { id: 'fact', version: 1, value: 'A' } }, async (request) => {
      requests.push(request);
      return requests.length === 1 ? first.promise : { revision: 3, profile: { ...request.profile, version: 3 } };
    });
    writer.setDesired({ id: 'fact', version: 1, value: 'B' });
    const saving = writer.flush();
    writer.setDesired({ id: 'fact', version: 1, value: 'C' });
    first.resolve({ revision: 2, profile: { id: 'fact', version: 2, value: 'B' } });
    await saving;
    expect(requests[1].profile).toEqual({ id: 'fact', version: 2, value: 'C' });
    expect(writer.status).toBe('saved');
    writer.dispose();
  });

  it('serializes A to B to A, clears fields, and advances only acknowledged revisions', async () => {
    const first = deferred<{ revision: number; profile: string }>();
    const requests: { expectedRevision: number; requestId: string; profile: string }[] = [];
    const writer = new RevisionWriter({ revision: 3, profile: 'A' }, async (request) => {
      requests.push(request);
      return requests.length === 1 ? first.promise : { revision: request.expectedRevision + 1, profile: request.profile };
    });
    writer.setDesired('B');
    const saving = writer.flush();
    writer.setDesired('A');
    first.resolve({ revision: 4, profile: 'B' });
    await saving;
    expect(requests.map((r) => [r.expectedRevision, r.profile])).toEqual([[3, 'B'], [4, 'A']]);
    expect(requests[0].requestId).not.toBe(requests[1].requestId);
    writer.setDesired('');
    await writer.flush();
    expect(writer.snapshot().desired).toBe('');
    expect(writer.status).toBe('saved');
    writer.dispose();
  });

  it('pauses on network/auth errors and recovers the exact unacknowledged request after reload', async () => {
    const requests: { requestId: string; expectedRevision: number; profile: string }[] = [];
    const writer = new RevisionWriter({ revision: 0, profile: '' }, async (request) => {
      requests.push(request);
      throw new ProfileSaveError('Session expired', 401);
    });
    writer.setDesired('first');
    await writer.flush();
    writer.setDesired('last');
    await writer.flush();
    expect(requests).toHaveLength(1);
    const saved = writer.snapshot();
    writer.dispose();
    const recovered = new RevisionWriter({ revision: 0, profile: '' }, async (request) => {
      requests.push(request);
      return { revision: request.expectedRevision + 1, profile: request.profile };
    }, undefined, saved);
    recovered.retry();
    await recovered.flush();
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[2].profile).toBe('last');
    expect(recovered.snapshot().revision).toBe(2);
    recovered.dispose();
  });

  it('keeps conflicts editable and requires explicit reconciliation before saving', async () => {
    let writes = 0;
    const writer = new RevisionWriter({ revision: 1, profile: 'old' }, async (request) => {
      if (++writes === 1) throw new ProfileSaveError('Conflict', 409, { revision: 2, profile: 'other tab' });
      return { revision: 3, profile: request.profile };
    });
    writer.setDesired('mine');
    await writer.flush();
    writer.setDesired('reviewed mine');
    writer.retry();
    await writer.flush();
    expect(writes).toBe(1);
    expect(writer.status).toBe('conflict');
    writer.reconcile({ revision: 2, profile: 'other tab' }, true);
    await writer.flush();
    expect(writer.snapshot().desired).toBe('reviewed mine');
    expect(writer.status).toBe('saved');
    writer.dispose();
  });

  it('aborts and ignores late results on a principal change, clearing plaintext', async () => {
    const hold = deferred<{ revision: number; profile: string }>();
    let signal!: AbortSignal;
    const writer = new RevisionWriter({ revision: 1, profile: 'private A' }, async (_, nextSignal) => {
      signal = nextSignal;
      return hold.promise;
    });
    writer.setDesired('private B');
    const saving = writer.flush();
    writer.dispose();
    expect(signal.aborted).toBe(true);
    hold.resolve({ revision: 2, profile: 'private B' });
    await saving;
    expect(() => writer.snapshot()).toThrow();
  });
});
