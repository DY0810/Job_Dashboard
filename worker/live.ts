import type { BrowserRuntime } from './browser.ts';

type Frame = { step: string; image?: string | null; fields?: { label: string; value: string }[] };

/**
 * Sends Workie a screenshot of the application tab every few seconds while the worker fills it, so the
 * applicant can watch from any device. Best effort: a failed frame never affects the application.
 */
export function liveView(post: (frame: Frame) => Promise<unknown>, runtime: BrowserRuntime, everyMs = 2_500) {
  let step = 'Opening the application', busy: Promise<void> | null = null, stopped = false;
  const shot = async () => {
    const page = await runtime.page();
    // The worker sends at most 128 KB a request; a busy page retries smaller once, then goes without a picture.
    for (const quality of [50, 25]) {
      const image = (await page.screenshot({ type: 'jpeg', quality, timeout: 3_000, caret: 'initial' })).toString('base64');
      if (image.length <= 120_000) return image;
    }
  };
  const send = () => busy ??= (async () => {
    try {
      const image = await shot().catch(() => undefined);
      if (!stopped) await post({ step, ...(image ? { image } : {}) });
    } catch { /* The next frame replaces a lost one. */ } finally { busy = null; }
  })();
  const timer = setInterval(send, everyMs);
  timer.unref?.();
  return {
    step(next: string) { step = next; void send(); },
    /** Ends the view. The last picture stays only for a form waiting on the applicant's approval. */
    async stop(last: string, fields?: Frame['fields'], keepImage = false) {
      clearInterval(timer);
      await busy;
      stopped = true;
      // The filled form, taken after the last field; a separate request from the answers so each fits in 128 KB.
      const image = keepImage ? await shot().catch(() => undefined) : null;
      await post({ step: last, ...(image !== undefined ? { image } : {}) }).catch(() => {});
      // ponytail: long essays are cut to 1500 characters when the whole list would not fit one request.
      const fit = fields && JSON.stringify(fields).length > 110_000
        ? fields.map(field => ({ ...field, value: field.value.length > 1500 ? `${field.value.slice(0, 1500)}…` : field.value })) : fields;
      if (fit?.length) await post({ step: last, fields: fit }).catch(() => {});
    },
  };
}
