import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ signedIn: false, hunterCalls: 0 }));
vi.mock('@/lib/applicant-access', () => ({
  lookupApplicant: async () => state.signedIn
    ? { applicant: { ownerId: 'o1', email: 'a@b.co', name: 'A' }, response: new Response(null) }
    : Response.json({ error: 'sign in' }, { status: 401 }),
  privateJson: (data: unknown, init?: ResponseInit) => Response.json(data, init),
}));
vi.mock('@/lib/db', () => ({ getDb: () => ({}), needsTurso: () => false }));
vi.mock('@/lib/query', () => ({
  getPostingDetail: async (_db: unknown, id: number) => id === 7 ? { id: 7, company: 'Nuro', canonicalUrl: 'https://nuro.ai/x' } : null,
}));
vi.mock('@/lib/recruiters', () => ({
  findRecruiters: async (posting: { company: string }) => {
    state.hunterCalls += 1;
    return { lookup: 'no_key', domain: null, people: [], searches: [{ label: `Recruiters at ${posting.company}`, url: 'u' }] };
  },
}));
import { GET } from './route.ts';

const call = (id: string) => GET(new Request(`https://workie.test/api/postings/${id}/recruiters`), { params: Promise.resolve({ id }) });

afterEach(() => { state.signedIn = false; state.hunterCalls = 0; });

describe('GET /api/postings/[id]/recruiters', () => {
  it('refuses a signed-out viewer without spending a lookup', async () => {
    const response = await call('7');
    expect(response.status).toBe(401);
    expect(state.hunterCalls).toBe(0);
  });

  it('returns the recruiters for a signed-in applicant', async () => {
    state.signedIn = true;
    const response = await call('7');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ searches: [{ label: 'Recruiters at Nuro' }] });
  });

  it('404s an unknown posting', async () => {
    state.signedIn = true;
    expect((await call('999')).status).toBe(404);
    expect((await call('abc')).status).toBe(404);
  });
});
