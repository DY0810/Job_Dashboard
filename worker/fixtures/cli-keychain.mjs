import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { PassThrough } from "node:stream";

// Test preload only: no native keychain import or plaintext fixture backup.
if (process.env.WORKIE_WORKER_OWNER !== "synthetic-cli-owner" ||
    !process.env.WORKIE_WORKER_ORIGIN?.startsWith("http://127.0.0.1:") || !process.send) {
  throw new Error("FIXTURE_ONLY");
}
const config = JSON.parse(readFileSync(0, "utf8"));
const items = new Map(config.items ?? []);
let operations = 0;
export class Entry {
  constructor(service, account) { this.key = JSON.stringify([service, account]); }
  getPassword() { operations++; return items.get(this.key) ?? null; }
  setPassword(value) { operations++; items.set(this.key, value); }
  deletePassword() { operations++; return items.delete(this.key); }
}
registerHooks({
  resolve(specifier, context, next) {
    if (specifier === "@napi-rs/keyring") return { url: import.meta.url, shortCircuit: true };
    return next(specifier, context);
  },
});
if (config.tty !== false) {
  const input = new PassThrough();
  Object.assign(input, {
    isTTY: true, isRaw: false,
    setRawMode(raw) {
      this.isRaw = raw;
      if (raw) queueMicrotask(() => input.write(`${config.grant ?? ""}\r`));
    },
  });
  Object.defineProperty(process, "stdin", { value: input });
}
process.once("beforeExit", () => {
  // Synthetic secrets cross an anonymous IPC channel only, never stdout or disk.
  process.send({ items: [...items], operations });
  process.disconnect();
});
