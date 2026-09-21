import type { ReadStream, WriteStream } from "node:tty";

export function readMaskedSecret(
  input: ReadStream = process.stdin, output: Pick<WriteStream, "write"> = process.stderr,
  prompt = "Secret (hidden): ", validate: (value: string) => Error | undefined = (value) => value ? undefined : new Error("INVALID_SECRET"),
  signal?: AbortSignal, maxLength = 16_384, overflowCode = "INVALID_SECRET",
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
          finish(validate(value));
          return;
        }
        if (char === "\u007f" || char === "\b") { value = value.slice(0, -1); continue; }
        if (char < " " || char === "\u007f" || value.length >= maxLength) { finish(new Error(overflowCode)); return; }
        value += char;
      }
    }
    try {
      output.write(prompt);
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

export function readMaskedGrant(
  input: ReadStream = process.stdin, output: Pick<WriteStream, "write"> = process.stderr, signal?: AbortSignal,
): Promise<string> {
  return readMaskedSecret(input, output, "Pairing grant (hidden): ", value =>
    /^[A-Za-z0-9_-]{43}$/.test(value) ? undefined : new Error("INVALID_GRANT"), signal, 43, "INVALID_GRANT");
}
