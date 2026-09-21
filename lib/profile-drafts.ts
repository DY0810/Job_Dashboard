// Browser-only primitives: never import auth, private database, or server configuration.
export type ProfileRevision<T> = { revision: number; profile: T };
export type ProfileRequest<T> = { expectedRevision: number; requestId: string; profile: T };
export type DraftSnapshot<T> = {
  revision: number; acknowledged: T; desired: T; pending: ProfileRequest<T> | null;
};
export type SaveStatus = 'saved' | 'pending' | 'saving' | 'paused' | 'conflict';

function rebaseVersions<T>(desired: T, acknowledged: T): T {
  const versions = new Map<string, Record<string, unknown>>();
  function collect(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.id === 'string') versions.set(item.id, item);
    if (!('state' in item)) Object.values(item).forEach(collect);
  }
  collect(acknowledged);
  const copy = structuredClone(desired);
  function update(value: unknown) {
    if (!value || typeof value !== 'object') return;
    const item = value as Record<string, unknown>;
    if (typeof item.id === 'string' && typeof item.version === 'number') {
      const ack = versions.get(item.id);
      item.version = ack?.version ?? 1;
      if (ack && 'state' in item) {
        const content = (v: Record<string, unknown>) => Object.fromEntries(Object.entries(v).filter(([k]) => !['version', 'confirmedAt'].includes(k)));
        if (JSON.stringify(content(item)) === JSON.stringify(content(ack))) item.confirmedAt = ack.confirmedAt;
      }
    }
    if (!('state' in item)) Object.values(item).forEach(update);
  }
  update(copy);
  return copy;
}

const bytes = (base64: string) => Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
const base64 = (data: ArrayBuffer) => {
  // Avoid a spread of a multi-megabyte profile onto the JavaScript call stack.
  let result = '';
  for (const byte of new Uint8Array(data)) result += String.fromCharCode(byte);
  return btoa(result);
};
export async function unlockDraftKey(raw: string): Promise<CryptoKey> {
  const value = bytes(raw);
  if (value.length !== 32) throw new Error('Invalid draft key');
  return crypto.subtle.importKey('raw', value, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

type Envelope = {
  version: 1; ownerId: string; schemaVersion: number; keyVersion: string;
  baseRevision: number; nonce: string; ciphertext: string; purpose?: 'inbox';
};
const aad = (e: Omit<Envelope, 'nonce' | 'ciphertext'>) => new TextEncoder().encode(JSON.stringify([
  e.version, e.ownerId, e.schemaVersion, e.keyVersion, e.baseRevision,
  ...(e.purpose ? [e.purpose] : []),
]));

export class DraftVault {
  readonly slot: string;
  private generation = 0;
  private disposed = false;
  pending = false;
  private readonly prefix: string;

  constructor(
    private readonly storage: Storage,
    private readonly ownerId: string,
    private readonly schemaVersion: number,
    private readonly keyVersion: string,
    private key: CryptoKey | null,
    slot?: string,
    private readonly encrypt = (key: CryptoKey, nonce: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, additionalData: Uint8Array<ArrayBuffer>) =>
      crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData }, key, data),
    private readonly purpose: 'profile' | 'inbox' = 'profile',
  ) {
    this.prefix = `workie:${purpose}-draft:${encodeURIComponent(ownerId)}:${schemaVersion}:`;
    this.slot = slot?.startsWith(this.prefix) ? slot : `${this.prefix}${crypto.randomUUID()}`;
  }

  slots(): string[] {
    return Array.from({ length: this.storage.length }, (_, i) => this.storage.key(i))
      .filter((key): key is string => key !== null && key.startsWith(this.prefix));
  }

  async save<T extends { revision: number }>(snapshot: T): Promise<boolean> {
    if (this.disposed || !this.key) return false;
    const generation = ++this.generation;
    this.pending = true;
    const header = {
      version: 1 as const, ownerId: this.ownerId, schemaVersion: this.schemaVersion,
      keyVersion: this.keyVersion, baseRevision: snapshot.revision,
      ...(this.purpose === 'inbox' ? { purpose: 'inbox' as const } : {}),
    };
    try {
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const encrypted = await this.encrypt(this.key, nonce, new TextEncoder().encode(JSON.stringify(snapshot)), aad(header));
      if (this.disposed || generation !== this.generation) return false;
      this.storage.setItem(this.slot, JSON.stringify({ ...header, nonce: base64(nonce.buffer), ciphertext: base64(encrypted) }));
      return true;
    } catch (error) {
      if (this.disposed || generation !== this.generation) return false;
      throw error;
    } finally {
      if (generation === this.generation) this.pending = false;
    }
  }

  async read(slot: string): Promise<unknown> {
    if (this.disposed || !this.key || !slot.startsWith(this.prefix)) throw new Error('Draft is locked');
    const e: Envelope = JSON.parse(this.storage.getItem(slot) ?? 'null');
    if (!e || e.version !== 1 || e.ownerId !== this.ownerId || e.schemaVersion !== this.schemaVersion ||
        (e.purpose ?? 'profile') !== this.purpose ||
        e.keyVersion !== this.keyVersion || !Number.isSafeInteger(e.baseRevision) || e.baseRevision < 0 ||
        typeof e.nonce !== 'string' || typeof e.ciphertext !== 'string' || bytes(e.nonce).length !== 12) {
      throw new Error('Draft cannot be authenticated');
    }
    const generation = this.generation;
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(e.nonce), additionalData: aad(e) }, this.key, bytes(e.ciphertext));
    if (this.disposed || generation !== this.generation) throw new Error('Draft is locked');
    const result = JSON.parse(new TextDecoder().decode(plaintext));
    if (result.revision !== e.baseRevision) throw new Error('Draft revision mismatch');
    return result;
  }

  async retire(slot: string, expected: unknown): Promise<void> {
    if (slot === this.slot || !slot.startsWith(this.prefix)) return;
    const ciphertext = this.storage.getItem(slot);
    if (JSON.stringify(await this.read(slot)) === JSON.stringify(expected) && this.storage.getItem(slot) === ciphertext) {
      this.storage.removeItem(slot);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.key = null;
    this.pending = false;
  }
}

export class ProfileSaveError<T = unknown> extends Error {
  constructor(message: string, readonly status: number, readonly current?: ProfileRevision<T>) { super(message); }
}

export class RevisionWriter<T> {
  private state: DraftSnapshot<T> | null;
  private flight: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation = 0;
  private blocked = false;
  status: SaveStatus = 'saved';
  error: ProfileSaveError<T> | null = null;

  constructor(
    initial: ProfileRevision<T>,
    private readonly write: (request: ProfileRequest<T>, signal: AbortSignal) => Promise<ProfileRevision<T>>,
    private readonly changed?: () => void,
    recovered?: DraftSnapshot<T>,
  ) {
    this.state = recovered ? structuredClone(recovered) :
      { revision: initial.revision, acknowledged: initial.profile, desired: initial.profile, pending: null };
    if (this.dirty) this.status = 'pending';
  }

  snapshot(): DraftSnapshot<T> {
    if (!this.state) throw new Error('Writer disposed');
    return structuredClone(this.state);
  }
  get dirty(): boolean {
    return !!this.state && (!!this.state.pending || JSON.stringify(this.state.desired) !== JSON.stringify(this.state.acknowledged));
  }
  setDesired(value: T): void {
    if (!this.state) return;
    this.state.desired = structuredClone(value);
    if (!this.blocked) this.status = this.dirty ? 'pending' : 'saved';
    this.changed?.();
    this.schedule();
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    if (!this.state || this.blocked || !this.dirty) return;
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 650);
  }
  pause(error = new ProfileSaveError<T>('Saving paused', 0)): void {
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.flight = null;
    this.blocked = true;
    this.error = error;
    this.status = error.status === 409 ? 'conflict' : 'paused';
    if (this.timer) clearTimeout(this.timer);
    this.changed?.();
  }
  retry(): void {
    if (!this.state || this.status === 'conflict') return;
    this.blocked = false;
    this.error = null;
    this.status = this.dirty ? 'pending' : 'saved';
    this.changed?.();
    this.schedule();
  }
  restorePending(request: ProfileRequest<T>): void {
    if (!this.state) return;
    this.state.pending = structuredClone(request);
    this.status = 'pending';
    this.changed?.();
  }
  reconcile(current: ProfileRevision<T>, keepDraft: boolean): void {
    if (!this.state) return;
    this.generation++;
    this.controller?.abort();
    this.flight = null;
    this.state = { revision: current.revision, acknowledged: structuredClone(current.profile),
      desired: keepDraft ? rebaseVersions(this.state.desired, current.profile) : structuredClone(current.profile), pending: null };
    this.blocked = false;
    this.error = null;
    this.status = this.dirty ? 'pending' : 'saved';
    this.changed?.();
    this.schedule();
  }
  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.state && !this.blocked && this.dirty) {
      if (this.flight) await this.flight;
      else await this.start();
    }
  }
  private async start(): Promise<void> {
    if (!this.state || this.blocked || !this.dirty) return;
    const generation = this.generation;
    const request = this.state.pending ?? {
      expectedRevision: this.state.revision, requestId: crypto.randomUUID(), profile: structuredClone(this.state.desired),
    };
    this.state.pending = request;
    this.status = 'saving';
    this.controller = new AbortController();
    this.changed?.();
    const work = this.write(request, this.controller.signal).then((ack) => {
      if (!this.state || generation !== this.generation) return;
      if (!Number.isSafeInteger(ack.revision) || ack.revision <= request.expectedRevision) {
        throw new ProfileSaveError('Invalid save acknowledgement', 0);
      }
      this.state.revision = ack.revision;
      this.state.acknowledged = structuredClone(ack.profile);
      if (JSON.stringify(this.state.desired) === JSON.stringify(request.profile)) {
        this.state.desired = structuredClone(ack.profile);
      } else this.state.desired = rebaseVersions(this.state.desired, ack.profile);
      this.state.pending = null;
      this.status = this.dirty ? 'pending' : 'saved';
      this.error = null;
    }).catch((error: unknown) => {
      if (!this.state || generation !== this.generation) return;
      this.blocked = true;
      this.error = error instanceof ProfileSaveError ? error : new ProfileSaveError('Network unavailable. Retry saving.', 0);
      if (this.error.status === 400 || this.error.status === 413 || this.error.status === 415) this.state.pending = null;
      this.status = this.error.status === 409 ? 'conflict' : 'paused';
    }).finally(() => {
      if (!this.state || generation !== this.generation) return;
      this.flight = null;
      this.controller = null;
      this.changed?.();
    });
    this.flight = work;
    await work;
  }
  dispose(): void {
    this.generation++;
    this.controller?.abort();
    if (this.timer) clearTimeout(this.timer);
    this.state = null;
    this.error = null;
    this.flight = null;
  }
}
