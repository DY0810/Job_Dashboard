import { describe, expect, it } from 'vitest';
import { findRecruiters, linkedinSearches } from './recruiters.ts';

const hunterBody = {
  data: {
    domain: 'nuro.ai',
    emails: [
      { value: 'pat@nuro.ai', first_name: 'Pat', last_name: 'Lee', position: 'HR Business Partner', linkedin: null },
      { value: 'Sam@Nuro.ai', first_name: 'Sam', last_name: 'Kim', position: 'University Recruiter', linkedin: 'https://www.linkedin.com/in/samkim' },
      { value: 'alex@nuro.ai', first_name: null, last_name: null, position: null, linkedin: 'alexr' },
    ],
  },
};
const fakeFetch = (body: unknown, status = 200, seen: string[] = []) =>
  (async (url: string | URL | Request) => { seen.push(String(url)); return new Response(JSON.stringify(body), { status }); }) as typeof fetch;

describe('linkedinSearches', () => {
  it('builds people searches with the company encoded', () => {
    const [first] = linkedinSearches('AT&T');
    expect(first.url).toBe('https://www.linkedin.com/search/results/people/?keywords=AT%26T%20recruiter');
  });
});

describe('findRecruiters', () => {
  it('without a key, returns only the LinkedIn searches', async () => {
    const result = await findRecruiters({ company: 'Nuro' }, { key: undefined, fetch: fakeFetch(hunterBody) });
    expect(result.lookup).toBe('no_key');
    expect(result.people).toEqual([]);
    expect(result.searches.length).toBeGreaterThan(0);
  });

  it('searches Hunter by company name and reports the domain Hunter resolved, recruiters first', async () => {
    const seen: string[] = [];
    const result = await findRecruiters({ company: 'Nuro' }, { key: 'k', fetch: fakeFetch(hunterBody, 200, seen) });
    expect(seen[0]).toContain('company=Nuro');
    expect(seen[0]).not.toContain('domain=');
    expect(seen[0]).toContain('department=hr');
    expect(result).toMatchObject({ lookup: 'ok', domain: 'nuro.ai' });
    expect(result.people).toEqual([
      { name: 'Sam Kim', title: 'University Recruiter', email: 'sam@nuro.ai', linkedin: 'https://www.linkedin.com/in/samkim' },
      { name: 'Pat Lee', title: 'HR Business Partner', email: 'pat@nuro.ai', linkedin: null },
      { name: null, title: null, email: 'alex@nuro.ai', linkedin: 'https://www.linkedin.com/in/alexr' },
    ]);
  });

  // A careers site is not where Hunter files the company's people: careers.withwaymo.com and
  // pinterestcareers.com return nobody, while the names resolve to waymo.com and pinterest.com.
  it('never searches the careers-site host the posting lives on', async () => {
    const seen: string[] = [];
    const waymo = { company: 'Waymo', canonicalUrl: 'https://careers.withwaymo.com/jobs/1' };
    await findRecruiters(waymo, { key: 'k2', fetch: fakeFetch(hunterBody, 200, seen) });
    expect(seen[0]).toContain('company=Waymo');
    expect(seen[0]).not.toContain('withwaymo');
  });

  it('reports Hunter failures as unavailable, never throws', async () => {
    const result = await findRecruiters({ company: 'Nuro' }, { key: 'k3', fetch: fakeFetch({ errors: [] }, 429) });
    expect(result).toMatchObject({ lookup: 'unavailable', people: [] });
  });
});
