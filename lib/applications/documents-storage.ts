import 'server-only';
import { constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { get, del } from '@vercel/blob';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export class DocumentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export type DocumentStorage =
  | { mode: 'local'; directory: string }
  | { mode: 'blob'; origin: string; token: string; callbackUrl: string }
  | { mode: 'unconfigured' };

const keyPattern = /^documents\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function assertDocumentKey(key: string) {
  if (!keyPattern.test(key)) throw new DocumentError(400, 'Invalid document key.');
}
function checkDirectory(path: string, create: boolean) {
  if (!isAbsolute(path) || resolve(path) !== path) throw new DocumentError(503, 'Document storage is unavailable.');
  const repo = realpathSync(process.cwd());
  const rel = relative(repo, path);
  if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) throw new DocumentError(503, 'Document storage must be outside the project.');
  const parents = [];
  for (let current = path; current !== dirname(current); current = dirname(current)) parents.unshift(current);
  for (const parent of parents) {
    let entry = lstatSync(parent, { throwIfNoEntry: false });
    if (!entry && create) {
      mkdirSync(parent, { mode: 0o700 });
      entry = lstatSync(parent);
    }
    if (entry && (!entry.isDirectory() || entry.isSymbolicLink())) throw new DocumentError(503, 'Document storage is unavailable.');
  }
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && ((entry.mode & 0o077) || (process.getuid && entry.uid !== process.getuid()))) {
    throw new DocumentError(503, 'Document directory must be private.');
  }
}
export function documentStorageConfig(env: Record<string, string | undefined> = process.env): DocumentStorage {
  try {
    if (!env.WORKIE_DOCUMENT_STORAGE) return { mode: 'unconfigured' };
    if (env.WORKIE_DOCUMENT_STORAGE === 'local' && !env.VERCEL && env.WORKIE_DOCUMENT_DIRECTORY) {
      checkDirectory(env.WORKIE_DOCUMENT_DIRECTORY, false);
      return { mode: 'local', directory: env.WORKIE_DOCUMENT_DIRECTORY };
    }
    if (env.WORKIE_DOCUMENT_STORAGE === 'blob' && env.VERCEL) {
      const origin = new URL(env.WORKIE_DOCUMENT_BLOB_ORIGIN ?? '');
      const callback = new URL(env.WORKIE_DOCUMENT_CALLBACK_URL ?? '');
      const auth = new URL(env.BETTER_AUTH_URL ?? '');
      const token = env.BLOB_READ_WRITE_TOKEN ?? '';
      const store = /^([a-z0-9]+)\.private\.blob\.vercel-storage\.com$/.exec(origin.hostname)?.[1];
      const tokenStore = /^vercel_blob_rw_([a-zA-Z0-9]+)_[a-zA-Z0-9]+$/.exec(token)?.[1]?.toLowerCase();
      if (!store || store !== tokenStore || origin.protocol !== 'https:' || origin.port ||
        origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
        callback.origin !== auth.origin || callback.protocol !== 'https:' ||
        callback.pathname !== '/api/documents/upload' || callback.search || callback.hash ||
        callback.username || callback.password) throw new Error('configuration');
      return { mode: 'blob', origin: origin.origin, token, callbackUrl: callback.href };
    }
    throw new Error('configuration');
  } catch { throw new DocumentError(503, 'Document storage is unavailable.'); }
}
export function documentBlobUrl(storage: DocumentStorage, key: string): string {
  assertDocumentKey(key);
  if (storage.mode !== 'blob') throw new DocumentError(503, 'Private Blob storage is unavailable.');
  return `${storage.origin}/${key}`;
}
export function assertDocumentBlobUrl(storage: DocumentStorage, key: string, url: string) {
  if (documentBlobUrl(storage, key) !== url) throw new DocumentError(409, 'Upload object does not match its grant.');
}
export async function boundedDocumentBytes(stream: ReadableStream<Uint8Array> | null, limit = MAX_DOCUMENT_BYTES, timeoutMs = 8000): Promise<Uint8Array> {
  if (!stream) throw new DocumentError(400, 'Document bytes required.');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => { void reader.cancel().catch(() => {}); reject(new DocumentError(408, 'Upload timed out.')); }, timeoutMs);
    });
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), deadline]);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw new DocumentError(413, 'Document exceeds the byte limit.');
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function writeDocumentObject(storage: DocumentStorage, key: string, bytes: Uint8Array) {
  assertDocumentKey(key);
  if (storage.mode !== 'local') throw new DocumentError(503, 'Local document storage is unavailable.');
  if (bytes.length > MAX_DOCUMENT_BYTES) throw new DocumentError(413, 'Document exceeds the byte limit.');
  checkDirectory(storage.directory, true);
  const path = join(storage.directory, key.slice('documents/'.length));
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } catch (error) {
    await unlink(path).catch(() => {});
    throw error;
  } finally { await file.close(); }
}
export async function readDocumentObject(storage: DocumentStorage, key: string): Promise<Uint8Array> {
  assertDocumentKey(key);
  if (storage.mode === 'blob') {
    const response = await get(documentBlobUrl(storage, key), {
      access: 'private', useCache: false, token: storage.token, abortSignal: AbortSignal.timeout(8000),
    });
    if (!response || response.statusCode !== 200 || !response.stream) throw new DocumentError(503, 'Document bytes are unavailable.');
    return boundedDocumentBytes(response.stream);
  }
  if (storage.mode !== 'local') throw new DocumentError(503, 'Document storage is unavailable.');
  checkDirectory(storage.directory, false);
  const file = await open(join(storage.directory, key.slice('documents/'.length)), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o077) || info.size > MAX_DOCUMENT_BYTES ||
      (process.getuid && info.uid !== process.getuid())) throw new DocumentError(503, 'Document bytes are unavailable.');
    const bytes = await boundedDocumentBytes(Readable.toWeb(file.createReadStream({ autoClose: false })) as ReadableStream<Uint8Array>);
    if (bytes.length !== info.size) throw new DocumentError(503, 'Document bytes changed.');
    return bytes;
  } finally { await file.close(); }
}
export async function removeDocumentObject(storage: DocumentStorage, key: string) {
  assertDocumentKey(key);
  if (storage.mode === 'blob') {
    await del(documentBlobUrl(storage, key), { token: storage.token, abortSignal: AbortSignal.timeout(8000) });
  } else if (storage.mode === 'local') {
    checkDirectory(storage.directory, false);
    const path = join(storage.directory, key.slice('documents/'.length));
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (entry && (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1)) throw new DocumentError(503, 'Document storage is unavailable.');
    await unlink(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  } else throw new DocumentError(503, 'Document storage is unavailable.');
}
