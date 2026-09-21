import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, join } from "node:path";
import type { WorkerScope } from "./credentials.ts";

const MAX_BYTES = 128 * 1024;
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === "ENOENT";

export async function privateStore(directory: string, scope: WorkerScope) {
  if (!isAbsolute(directory) || process.platform === "win32") throw new Error("PRIVATE_DIRECTORY_REQUIRED");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())) throw new Error("UNSAFE_DIRECTORY");
  const root = await realpath(directory);
  const prefix = createHash("sha256").update(JSON.stringify([scope.origin, scope.ownerId, scope.workerId])).digest("hex");
  const path = (name: string) => {
    if (!/^[a-z][a-z-]{0,39}$/.test(name)) throw new Error("INVALID_STATE_NAME");
    return join(root, `${prefix}-${name}.json`);
  };
  async function read(name: string): Promise<unknown | null> {
    let file;
    try { file = await open(path(name), constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (missing(error)) return null; throw new Error("LOCAL_STATE_UNREADABLE"); }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error("UNSAFE_STATE_FILE");
      if (stat.size > MAX_BYTES) throw new Error("LOCAL_STATE_LIMIT");
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < bytes.length) {
        const { bytesRead } = await file.read(bytes, size, bytes.length - size, null);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error("LOCAL_STATE_LIMIT");
      return JSON.parse(bytes.subarray(0, size).toString("utf8"));
    } finally { await file.close(); }
  }
  async function syncDirectory() {
    const dir = await open(root, constants.O_RDONLY);
    try { await dir.sync(); } finally { await dir.close(); }
  }
  async function write(name: string, value: unknown) {
    const target = path(name);
    const bytes = JSON.stringify(value);
    if (Buffer.byteLength(bytes) > MAX_BYTES) throw new Error("LOCAL_STATE_LIMIT");
    const temporary = `${target}.${randomUUID()}.tmp`;
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
      await file.close();
      await rename(temporary, target);
      await syncDirectory();
    } finally {
      await file.close();
      await unlink(temporary).catch(error => { if (!missing(error)) throw error; });
    }
  }
  async function remove(name: string) {
    await unlink(path(name)).catch(error => { if (!missing(error)) throw error; });
    await syncDirectory();
  }
  async function lock() {
    const filename = path("lock");
    const nonce = randomUUID();
    async function acquire() {
      const file = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await file.writeFile(JSON.stringify({ pid: process.pid, nonce })); await file.sync(); }
      finally { await file.close(); }
      return async () => {
        const current = await read("lock") as { nonce?: string } | null;
        if (current?.nonce === nonce) await remove("lock");
      };
    }
    try { return await acquire(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const recovery = `${filename}.recovery`;
      // ponytail: an abandoned recovery mutex needs manual inspection, never unsafe lock stealing.
      try { await mkdir(recovery, { mode: 0o700 }); } catch { throw new Error("WORKER_LOCKED"); }
      try {
        const current = await read("lock") as { pid?: number } | null;
        if (current) {
          if (!Number.isSafeInteger(current.pid) || current.pid! <= 0) throw new Error("WORKER_LOCKED");
          let dead = false;
          try { process.kill(current.pid!, 0); }
          catch (probe) { dead = (probe as NodeJS.ErrnoException).code === "ESRCH"; }
          if (!dead) throw new Error("WORKER_LOCKED");
          await remove("lock");
        }
        try { return await acquire(); } catch { throw new Error("WORKER_LOCKED"); }
      } finally { await rmdir(recovery); }
    }
  }
  return { path, read, write, remove, lock };
}
export type PrivateStore = Awaited<ReturnType<typeof privateStore>>;
