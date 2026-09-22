import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

export type DocumentValidation = {
  status: 'passed' | 'rejected' | 'deferred';
  size: number;
  sha256: string;
  mime: string;
};

let activeWorkers = 0;

function validPng(bytes: Uint8Array) {
  if (bytes.length < 24 || !bytes.subarray(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index])) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint32(8) === 13 && view.getUint32(12) === 0x49484452 && view.getUint32(16) > 0 && view.getUint32(20) > 0;
}

function validJpeg(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false;
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) return false;
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return false;
    if (offset + 1 >= bytes.length) return false;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) return false;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      const height = (bytes[offset + 3] << 8) | bytes[offset + 4];
      const width = (bytes[offset + 5] << 8) | bytes[offset + 6];
      return length >= 8 && height > 0 && width > 0;
    }
    offset += length;
  }
  return false;
}

function validImage(bytes: Uint8Array, mime: string) {
  return mime === 'image/png' ? validPng(bytes) : mime === 'image/jpeg' && validJpeg(bytes);
}

export async function validateDocumentBytes(bytes: Uint8Array, mime: string, timeoutMs = 5000): Promise<DocumentValidation> {
  const result = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime };
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return { ...result, status: 'rejected' };
  if (mime === 'image/png' || mime === 'image/jpeg') return { ...result, status: validImage(bytes, mime) ? 'passed' : 'rejected' };
  // ponytail: two parsers per process; durable quarantine absorbs excess work.
  if (activeWorkers >= 2) return { ...result, status: 'deferred' };
  activeWorkers++;
  try {
    return await new Promise<DocumentValidation>((resolve) => {
      let settled = false;
      const worker = new Worker(join(process.cwd(), 'lib/applications/documents-parse-worker.mjs'), {
        workerData: { bytes, mime }, env: {}, execArgv: [],
        // V8 heap only; the pinned worker guards binary allocations BEFORE decode.
        resourceLimits: { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16, stackSizeMb: 4 },
        stdout: true, stderr: true,
      });
      const finish = (status: DocumentValidation['status']) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        void worker.terminate().finally(() => resolve({ ...result, status }));
      };
      const timer = setTimeout(() => finish('deferred'), timeoutMs);
      worker.stdout.resume();
      worker.stderr.resume();
      worker.on('message', (status) => finish(status === 'passed' ? 'passed' : 'rejected'));
      worker.on('error', () => finish('deferred'));
      worker.on('exit', () => finish('deferred'));
    });
  } catch { return { ...result, status: 'deferred' }; }
  finally { activeWorkers--; }
}
