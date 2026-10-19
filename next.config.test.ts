import { describe, expect, it } from 'vitest';
// The same route compiler and has/missing matcher a production build and the router use.
import { buildCustomRoute } from 'next/dist/lib/build-custom-route';
import { matchHas } from 'next/dist/shared/lib/router/utils/prepare-destination';
import loadConfig from 'next/dist/server/config';

// 2026-10-19: the alias redirect also moved each deployment's own URL and a bare /api to workie.page.
describe('production host redirect', () => {
  it('moves pages on a *.vercel.app alias to the household origin, and nothing else', async () => {
    const deployment = 'job-dashboard-abc123-dy0810s-projects.vercel.app';
    Object.assign(process.env, { VERCEL_ENV: 'production', BETTER_AUTH_URL: 'https://workie.page', VERCEL_URL: deployment });
    const routes = (await (await loadConfig('phase-production-build', process.cwd(), { silent: true })).redirects!())
      .map((route) => ({ route, regex: new RegExp(buildCustomRoute('redirect', route, ['/_next']).regex) }));
    const redirects = (host: string, path: string) => routes.some(({ route, regex }) => regex.test(path) &&
      !!matchHas({ headers: { host } } as never, {}, route.has, route.missing));
    const alias = 'job-dashboard-one-sigma.vercel.app';
    expect(['/', '/applications', '/apis-like'].map((path) => redirects(alias, path))).toEqual([true, true, true]);
    expect(['/api', '/api/', '/api/questions/answers', '/_next/static/a.js'].some((path) => redirects(alias, path))).toBe(false);
    expect(redirects('workie.page', '/applications')).toBe(false);
    expect(redirects(deployment, '/applications')).toBe(false);
  });
});
