import type { ReadStream, WriteStream } from "node:tty";

export function readMaskedGrant(
  input: ReadStream = process.stdin, output: Pick<WriteStream, "write"> = process.stderr, signal?: AbortSignal,
): Promise<string> {
  if (!input.isTTY || typeof input.setRawMode !== "function") return Promise.reject(new Error("TTY_REQUIRED"));
  if (signal?.aborted) return Promise.reject(new Error("STOPPED"));
  return new Promise((resolve, reject) => {
    let value = "";
    let finished = false;
    const raw = input.isRaw, wasPaused = input.isPaused();
    const timer = setTimeout(() => finish(new Error("INPUT_TIMEOUT")), 120000);
    const abort = () => finish(new Error("STOPPED"));
    const ended = () => finish(new Error("INPUT_CLOSED"));
    function finish(error?: Error) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      input.removeListener("data", data);
      input.removeListener("error", ended);
      input.removeListener("end", ended);
      input.removeListener("close", ended);
      signal?.removeEventListener("abort", abort);
      try { input.setRawMode(raw); } catch { error ??= new Error("INPUT_CLOSED"); }
      try {
        if (wasPaused) input.pause();
        output.write("\n");
      } catch { error ??= new Error("INPUT_CLOSED"); }
      if (error) { value = ""; reject(error); }
      else { resolve(value); value = ""; }
    }
    function data(chunk: Buffer | string) {
      for (const char of chunk.toString()) {
        if (char === "\u0003" || char === "\u0004") { finish(new Error("STOPPED")); return; }
        if (char === "\r" || char === "\n") {
          finish(/^[A-Za-z0-9_-]{43}$/.test(value) ? undefined : new Error("INVALID_GRANT"));
          return;
        }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (!/^[A-Za-z0-9_-]$/.test(char) || value.length >= 43) { finish(new Error("INVALID_GRANT")); return; }
        value += char;
      }
    }
    try {
      output.write("Pairing grant (hidden): ");
      input.setRawMode(true);
      input.on("data", data);
      input.once("error", ended);
      input.once("end", ended);
      input.once("close", ended);
      signal?.addEventListener("abort", abort, { once: true });
      input.resume();
    } catch { finish(new Error("INPUT_CLOSED")); }
  });
}
