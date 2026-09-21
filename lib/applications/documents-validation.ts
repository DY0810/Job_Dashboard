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
export async function validateDocumentBytes(bytes: Uint8Array, mime: string, timeoutMs = 5000): Promise<DocumentValidation> {
  const result = { size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), mime };
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return { ...result, status: 'rejected' };
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
