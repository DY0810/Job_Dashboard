import { describe, expect, it } from 'vitest';
import { syncApplied } from './applied-sync';

function storage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return { get length() { return map.size; }, key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => { map.set(key, value); }, map };
}
function server(signedIn = true) {
  const calls: { path: string; owner: string | null; body: Record<string, unknown> | null }[] = [];
  const request = (async (path: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ path, owner: new Headers(init?.headers).get('x-workie-applicant'), body });
    if (path === '/api/auth/applicant') return signedIn ? Response.json({ ownerId: 'dy' }) : new Response(null, { status: 401 });
    if (path.endsWith('/preview')) return Response.json({ previewToken: 'token-1', previewHash: 'hash-1' });
    return Response.json({ status: 'manual_reported' });
  }) as typeof fetch;
  return { calls, request };
}

describe('board applied checkbox sync', () => {
  it('reports checked postings once to the signed-in applicant through import preview and confirm', async () => {
    const store = storage({ 'workie-applied:12': '1', 'workie-applied:7': '1', 'workie-applied:9': '0', 'workie-default-filters': 'tab=x' });
    const { calls, request } = server();
    expect(await syncApplied(store, request)).toBe(2);
    expect(calls.map((call) => call.path)).toEqual(['/api/auth/applicant', '/api/applications/import/preview', '/api/applications/import/confirm']);
    expect(calls[1]).toMatchObject({ owner: 'dy', body: { postingIds: [12, 7] } });
    expect(calls[2]).toMatchObject({ owner: 'dy', body: { previewToken: 'token-1', previewHash: 'hash-1', postingIds: [12, 7], confirmOwnership: true } });
    expect(calls[1].body!.requestId).not.toBe(calls[2].body!.requestId);
    // Already reported postings are not sent again; a new check is.
    store.setItem('workie-applied:30', '1');
    expect(await syncApplied(store, request)).toBe(1);
    expect(calls.at(-1)!.body).toMatchObject({ postingIds: [30] });
  });

  it('stays browser-only when signed out or when nothing is checked', async () => {
    const signedOut = server(false);
    expect(await syncApplied(storage({ 'workie-applied:12': '1' }), signedOut.request)).toBe(0);
    expect(signedOut.calls.map((call) => call.path)).toEqual(['/api/auth/applicant']);
    const empty = server();
    expect(await syncApplied(storage({}), empty.request)).toBe(0);
    expect(empty.calls).toEqual([]);
  });
});
