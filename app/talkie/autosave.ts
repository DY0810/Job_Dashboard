/** What the server's last acknowledged body means for the browser's newest local text. */
export function reconcileBody(currentBody: string, persistedBody: string): {
  patchBody: string | null;
  matches: boolean;
} {
  const current = currentBody.trim();
  const persisted = persistedBody.trim();
  return { patchBody: current === persisted ? null : current, matches: current === persisted };
}

/** A late response may only bind to the draft that issued it, never a newer replacement. */
export function shouldAttachServerId(activeClientKey: string | null | undefined, responseClientKey: string): boolean {
  return activeClientKey === responseClientKey;
}

type Draft = { body: string; x: number; y: number; w: number; h: number };
export function sameNoteDraft(current: Draft, persisted: Draft): boolean {
  return reconcileBody(current.body, persisted.body).matches
    && (['x', 'y', 'w', 'h'] as const).every((key) => current[key] === persisted[key]);
}

type DeferredWriterOptions = {
  delayMs: number;
  write: (body: string) => Promise<void>;
  onAcknowledged?: (body: string) => void;
  onError?: (error: unknown) => void;
};

/**
 * One note's ordered write lane. A later local value is never compared to a rendered prop:
 * while B is in flight, returning to A must queue A because B will become the next server
 * state. The board uses this directly; tests exercise its actual deferred orchestration.
 */
export class DeferredEditWriter {
  private acknowledged: string;
  private desired: string;
  private inFlight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private failed = false;

  constructor(
    initial: string,
    private readonly options: DeferredWriterOptions,
  ) {
    this.acknowledged = initial.trim();
    this.desired = initial;
  }

  setDesired(body: string): void {
    this.desired = body;
    this.failed = false;
    this.schedule();
  }

  retry(): void {
    this.failed = false;
    this.schedule(0);
  }

  dispose(): void {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    while (this.needsWrite() || this.inFlight) {
      if (this.inFlight) await this.inFlight;
      else await this.start();
    }
  }

  private needsWrite(): boolean {
    return Boolean(this.desired.trim()) && this.desired.trim() !== this.acknowledged;
  }

  private schedule(delay: number = this.options.delayMs): void {
    if (this.disposed || !this.needsWrite()) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.start().catch(() => {});
    }, delay);
  }

  private async start(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.needsWrite()) return;
    const body = this.desired.trim();
    const work = this.options.write(body)
      .then(() => {
        this.acknowledged = body;
        this.options.onAcknowledged?.(body);
      })
      .catch((error) => {
        // A failure only blocks automatic retries for the same desired body. Fresh input
        // during a failed request is new work and may proceed after this write settles.
        if (this.desired.trim() === body) this.failed = true;
        this.options.onError?.(error);
        throw error;
      })
      .finally(() => {
        this.inFlight = null;
        // A keystroke that arrived while this write was in flight must run next, even when it
        // happens to equal the body that was acknowledged before this request started.
        if (!this.disposed && !this.failed && this.needsWrite()) void this.start().catch(() => {});
      });
    this.inFlight = work;
    return work;
  }
}
