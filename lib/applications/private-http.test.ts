import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getEventListeners } from 'node:events';
import { z } from 'zod';
import { MAX_PRIVATE_JSON, PrivateInputError, readPrivateJson } from './private-http';

vi.mock('server-only', () => ({}));
const schema = z.object({ ok: z.boolean() });
function request(body: ReadableStream<Uint8Array> | string, signal?: AbortSignal) {
  return new Request('https://workie.example.test/api/profile', {
    method: 'PATCH', headers: { 'content-type': 'application/json', 'content-length': '1' },
    body, signal, duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}
function cleaned(req: Request) {
  expect(req.body?.locked).toBe(false);
  expect(getEventListeners(req.signal, 'abort')).toHaveLength(0);
  expect(vi.getTimerCount()).toBe(0);
}
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden.'); }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it.each(['resolves', 'never resolves', 'rejects'] as const)(
  'times out a partial never-ending body and releases the lock when cancel %s', async (cancellation) => {
    const cancel = vi.fn(() => cancellation === 'never resolves' ? new Promise<void>(() => {})
      : cancellation === 'rejects' ? Promise.reject(new Error('private source details')) : Promise.resolve());
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":')); }, cancel,
    });
    const req = request(body);
    let failure: unknown;
    const reading = readPrivateJson(req, schema).catch((error: unknown) => { failure = error; });
    await vi.advanceTimersByTimeAsync(7999);
    expect(failure).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(failure).toBeInstanceOf(PrivateInputError);
    expect(failure).toMatchObject({ status: 408, message: 'Request body timed out.' });
    await reading;
    expect(cancel).toHaveBeenCalledOnce();
    cleaned(req);
    const reader = body.getReader();
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    reader.releaseLock();
  },
);
it('uses one hard deadline, not a fresh timeout for every chunk', async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const req = request(new ReadableStream<Uint8Array>({ start(value) { controller = value; } }));
  let failure: unknown;
  const reading = readPrivateJson(req, schema).catch((error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(4000);
  controller.enqueue(new TextEncoder().encode('{"ok":'));
  await vi.advanceTimersByTimeAsync(3999);
  expect(failure).toBeUndefined();
  controller.enqueue(new TextEncoder().encode('true}'));
  await vi.advanceTimersByTimeAsync(1);
  expect(failure).toMatchObject({ status: 408 });
  await reading;
  cleaned(req);
});
it.each([false, true])('honors request abort (already aborted: %s) without waiting for cancel', async (alreadyAborted) => {
  const abort = new AbortController();
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const body = new ReadableStream<Uint8Array>({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"ok":true}')); }, cancel,
  });
  if (alreadyAborted) abort.abort(new Error('private abort details'));
  const req = request(body, abort.signal);
  let failure: unknown;
  const reading = readPrivateJson(req, schema).catch((error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(0);
  if (!alreadyAborted) abort.abort(new Error('private abort details'));
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toBeInstanceOf(PrivateInputError);
  expect(failure).toMatchObject({ status: 400, message: 'Invalid request body.' });
  await reading;
  expect(cancel).toHaveBeenCalledOnce();
  cleaned(req);
});
it('enforces actual bytes despite lying Content-Length and a never-resolving cancel', async () => {
  const cancel = vi.fn(() => new Promise<void>(() => {}));
  const req = request(new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(MAX_PRIVATE_JSON));
      controller.enqueue(new Uint8Array(1));
    }, cancel,
  }));
  let failure: unknown;
  const reading = readPrivateJson(req, schema).catch((error: unknown) => { failure = error; });
  await vi.advanceTimersByTimeAsync(0);
  expect(failure).toMatchObject({ status: 413, message: 'Request too large.' });
  await reading;
  expect(cancel).toHaveBeenCalledOnce();
  cleaned(req);
});
it('sanitizes a source read failure and cleans up the deadline and abort listener', async () => {
  const req = request(new ReadableStream<Uint8Array>({
    pull(controller) { controller.error(new Error('private source details')); },
  }));
  await expect(readPrivateJson(req, schema)).rejects.toMatchObject({ status: 400, message: 'Invalid request body.' });
  cleaned(req);
});
it('preserves valid JSON, schema validation, UTF-8 validation and the exact byte cap', async () => {
  const valid = request('{"ok":true}');
  await expect(readPrivateJson(valid, schema)).resolves.toEqual({ ok: true });
  cleaned(valid);
  const exact = request(JSON.stringify('x'.repeat(MAX_PRIVATE_JSON - 2)));
  await expect(readPrivateJson(exact, z.string())).resolves.toHaveLength(MAX_PRIVATE_JSON - 2);
  cleaned(exact);
  for (const bytes of [new TextEncoder().encode('{'), new Uint8Array([0xff])]) {
    const invalid = request(new ReadableStream({
      start(controller) { controller.enqueue(bytes); controller.close(); },
    }));
    await expect(readPrivateJson(invalid, schema)).rejects.toMatchObject({ status: 400, message: 'Invalid JSON.' });
    cleaned(invalid);
  }
  const invalid = request('{"ok":1}');
  await expect(readPrivateJson(invalid, schema)).rejects.toMatchObject({ status: 400, message: 'Invalid request fields.' });
  cleaned(invalid);
});
