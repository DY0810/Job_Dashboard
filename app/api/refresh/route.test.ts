import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../../lib/db/index.ts';
import { claimRequest, finishRequest } from '../../../lib/refresh-queue.ts';

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('../../../lib/db/index.ts')>(),
  getDb: () => state.db!,
}));
import { GET, POST } from './route.ts';

const url = 'https://workie.test/api/refresh';
beforeEach(() => {
  state.db = openDb(':memory:', { migrate: true });
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('TURSO_DATABASE_URL', 'file:unused');
  vi.stubEnv('WORKIE_GH_TOKEN', '');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('hosted refresh', () => {
  it('reports scheduled-only honestly when dispatch is not configured', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const response = await POST(new Request(url, { method: 'POST' }));
    const result = await response.json();
    expect(response.status).toBe(202);
    expect(result).toMatchObject({ dispatch: 'scheduled', dispatchConfigured: false, request: { status: 'queued' } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('dispatches once and waits for persisted completion, not a connector timestamp', async () => {
    vi.stubEnv('WORKIE_GH_TOKEN', 'test-only');
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const result = await (await POST(new Request(url, { method: 'POST' }))).json();
    expect(result.dispatch).toBe('started');
    await POST(new Request(url, { method: 'POST' }));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0][0]).toContain('/actions/workflows/refresh.yml/dispatches');

    const claim = await claimRequest(state.db!);
    const request = new Request(`${url}?request=${result.request.id}`);
    expect(await (await GET(request)).json()).toMatchObject({ request: { status: 'running' }, lastRunAt: null });
    await finishRequest(state.db!, claim!, null);
    expect(await (await GET(request)).json()).toMatchObject({ request: { status: 'succeeded' }, queued: false });
  });

  it('retains a queued request when dispatch fails', async () => {
    vi.stubEnv('WORKIE_GH_TOKEN', 'test-only');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    expect(await (await POST(new Request(url, { method: 'POST' }))).json()).toMatchObject({
      dispatch: 'failed', queued: true, request: { status: 'queued' },
    });
  });

  it('rejects malformed request IDs', async () => {
    expect((await GET(new Request(`${url}?request=-1`))).status).toBe(400);
  });
});
