/**
 * Reads a body stream into one buffer and throws `overflow()` once more than `max` bytes arrive.
 * Callers keep their own Content-Length rules, decoding and error classes. Read errors propagate
 * unchanged. The stream is always cancelled (never awaited, so a stuck source cannot hold the
 * caller) and unlocked. Plain erasable TypeScript: the worker imports this file under node.
 */
export async function readCapped(stream: ReadableStream<Uint8Array>, max: number, options: {
  overflow: () => Error;
  /** One hard deadline for the whole read; setTimeout so fake timers control it. */
  timeout?: { ms: number; error: () => Error };
  abort?: { signal: AbortSignal; error: () => Error };
}): Promise<Buffer> {
  const { timeout, abort } = options;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    if (abort?.signal.aborted) throw abort.error();
    const stop = timeout || abort ? new Promise<never>((_, reject) => {
      if (timeout) timer = setTimeout(() => reject(timeout.error()), timeout.ms);
      if (abort) {
        onAbort = () => reject(abort.error());
        abort.signal.addEventListener('abort', onAbort, { once: true });
      }
    }) : undefined;
    for (;;) {
      const { done, value } = await (stop ? Promise.race([reader.read(), stop]) : reader.read());
      if (abort?.signal.aborted) throw abort.error();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw options.overflow();
      chunks.push(value);
    }
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    if (onAbort) abort!.signal.removeEventListener('abort', onAbort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
