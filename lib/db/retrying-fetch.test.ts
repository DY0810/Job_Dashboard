import { afterEach, describe, expect, it, vi } from 'vitest';

import { driver, getDb, retryingFetch, tursoFetch } from './index.ts';
import { connectorRuns } from './schema.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

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

/** A Hrana pipeline, the shape libSQL POSTs for one statement. */
function pipeline(sql: string): Request {
  const requests = [{ type: 'execute', stmt: { sql, args: [], want_rows: true } }, { type: 'close' }];
  return new Request('https://db.test/v2/pipeline', { method: 'POST', body: JSON.stringify({ baton: null, requests }) });
}

/** What production logged on `/`: the socket closed before Turso answered. */
const dropped = () => new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

describe('tursoFetch', () => {
  it('gives up on a request Turso never answers instead of waiting out the function', async () => {
    vi.stubGlobal('fetch', vi.fn((_: Request, init: RequestInit) => new Promise((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    await expect(tursoFetch(pipeline('insert into notes (id) values (1)'), 20)).rejects.toThrow(/timeout/i);
  });

  it('never resends a write, which the server may already have run', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw dropped(); }));
    await expect(tursoFetch(pipeline('insert into notes (id) values (1)'))).rejects.toThrow('fetch failed');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reads the board's last run through one dropped socket", async () => {
    vi.stubEnv('VERCEL', '1');
    vi.stubEnv('TURSO_DATABASE_URL', 'https://db.test');
    vi.stubEnv('TURSO_AUTH_TOKEN', 'token');
    delete (globalThis as { __workieDb?: unknown }).__workieDb;
    const sql: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (request: Request) => {
      sql.push(JSON.parse(await request.text()).requests[0].stmt.sql);
      if (sql.length === 1) throw dropped();
      const result = { cols: [{ name: 'started_at' }], rows: [[{ type: 'integer', value: '1792466000000' }]], affected_row_count: 0 };
      return Response.json({ baton: null, results: [{ type: 'ok', response: { type: 'execute', result } }, { type: 'ok', response: { type: 'close' } }] });
    }));
    try {
      const run = await driver(getDb()).select({ startedAt: connectorRuns.startedAt }).from(connectorRuns).limit(1).get();
      expect(run?.startedAt.getTime()).toBe(1792466000000);
      expect(sql).toHaveLength(2);
      expect(sql[1]).toBe(sql[0]);
    } finally {
      delete (globalThis as { __workieDb?: unknown }).__workieDb;
    }
  });
});
