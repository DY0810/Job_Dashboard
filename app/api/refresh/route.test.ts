import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDb, type Db } from '../../../lib/db/index.ts';
import { CLAIM_TIMEOUT_MS, claimRequest, finishRequest } from '../../../lib/refresh-queue.ts';
import { refreshRequests } from '../../../lib/db/schema.ts';

const state = vi.hoisted(() => ({ db: null as Db | null }));
vi.mock('@/lib/db', async (original) => ({
  ...await original<typeof import('../../../lib/db/index.ts')>(),
  getDb: () => state.db!,
}));
import { GET, POST } from './route.ts';
import { GET as CRON_GET } from '../cron/refresh/route.ts';

const url = 'https://workie.test/api/refresh';
beforeEach(() => {
  state.db = openDb(':memory:', { migrate: true });
  vi.stubEnv('VERCEL', '1');
  vi.stubEnv('TURSO_DATABASE_URL', 'file:unused');
  vi.stubEnv('WORKIE_GH_TOKEN', '');
  vi.stubEnv('CRON_SECRET', '');
  vi.stubEnv('VERCEL_ENV', 'production');
});

describe('external scheduler', () => {
  const cronUrl = 'https://workie.test/api/cron/refresh';
  const authorized = () => new Request(cronUrl, {
    headers: { authorization: 'Bearer scheduler-test-only' },
  });

  it('fails closed before creating requests when credentials or the environment are missing', async () => {
    expect((await CRON_GET(authorized())).status).toBe(503);
    vi.stubEnv('CRON_SECRET', 'scheduler-test-only');
    expect((await CRON_GET(new Request(cronUrl))).status).toBe(401);
    expect((await CRON_GET(new Request(cronUrl, {
      headers: { authorization: 'Bearer wrong' },
    }))).status).toBe(401);
    expect((await CRON_GET(authorized())).status).toBe(503);
    vi.stubEnv('WORKIE_GH_TOKEN', 'test-only');
    vi.stubEnv('VERCEL_ENV', 'preview');
    expect((await CRON_GET(authorized())).status).toBe(503);
    expect(state.db!.select().from(refreshRequests).all()).toHaveLength(0);
  });

  it('retries an unclaimed failed dispatch without bypassing public coalescing or creating another request', async () => {
    vi.stubEnv('CRON_SECRET', 'scheduler-test-only');
    vi.stubEnv('WORKIE_GH_TOKEN', 'test-only');
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    const failed = await CRON_GET(authorized());
    expect(failed.status).toBe(502);
    const original = await failed.json();
    const publicRetry = await (await POST(new Request(url, { method: 'POST' }))).json();
    expect(publicRetry.dispatch).toBe('coalesced');
    expect(fetch).toHaveBeenCalledTimes(1);
    const retried = await CRON_GET(authorized());
    expect(retried.status).toBe(202);
    const result = await retried.json();
    expect(result).toMatchObject({ dispatch: 'started', request: { id: original.request.id } });
    expect(state.db!.select().from(refreshRequests).all()).toHaveLength(1);

    await claimRequest(state.db!);
    expect(await (await CRON_GET(authorized())).json()).toMatchObject({ dispatch: 'coalesced' });
    expect(fetch).toHaveBeenCalledTimes(2);
    state.db!.update(refreshRequests).set({ claimedAt: new Date(Date.now() - CLAIM_TIMEOUT_MS - 1) }).run();
    expect(await (await CRON_GET(authorized())).json()).toMatchObject({ dispatch: 'started' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });
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
