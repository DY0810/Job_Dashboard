import { afterEach, describe, expect, it, vi } from 'vitest';

import { retryingFetch } from './index.ts';

afterEach(() => vi.unstubAllGlobals());

describe('retryingFetch', () => {
  it('resends the full body once when the pooled socket is dead', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      bodies.push(await request.text());
      if (bodies.length === 1) throw new TypeError('fetch failed', { cause: { code: 'EPIPE' } });
      return new Response('ok');
    }));
    const response = await retryingFetch(new Request('https://db.test/v2/pipeline', { method: 'POST', body: 'stmt' }));
    expect(await response.text()).toBe('ok');
    expect(bodies).toEqual(['stmt', 'stmt']);
  });

  it('gives up after the second network failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(retryingFetch(new Request('https://db.test/', { method: 'POST', body: 'x' }))).rejects.toThrow('fetch failed');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
