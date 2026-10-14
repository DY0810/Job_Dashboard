import { describe, expect, it } from 'vitest';
import { employerDomain, findRecruiters, linkedinSearches } from './recruiters.ts';

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

describe('employerDomain', () => {
  it.each([
    ['https://nuro.ai/careersitem?gh_jid=1', 'nuro.ai'],
    ['https://www.careers.example.com/jobs/1', 'careers.example.com'],
    ['https://boards.greenhouse.io/acme/jobs/1', null],
    ['https://jobs.lever.co/acme/1', null],
    ['https://acme.wd5.myworkdayjobs.com/x', null],
    ['https://jobs.ashbyhq.com/acme/1', null],
    ['not a url', null],
  ])('%s -> %s', (url, domain) => expect(employerDomain(url)).toBe(domain));
});

describe('linkedinSearches', () => {
  it('builds people searches with the company encoded', () => {
    const [first] = linkedinSearches('AT&T');
    expect(first.url).toBe('https://www.linkedin.com/search/results/people/?keywords=AT%26T%20recruiter');
  });
});

describe('findRecruiters', () => {
  it('without a key, returns only the LinkedIn searches', async () => {
    const result = await findRecruiters({ company: 'Nuro', canonicalUrl: 'https://nuro.ai/x' }, { key: undefined, fetch: fakeFetch(hunterBody) });
    expect(result.lookup).toBe('no_key');
    expect(result.people).toEqual([]);
    expect(result.searches.length).toBeGreaterThan(0);
  });

  it('searches Hunter by the employer domain, recruiters first, LinkedIn normalised', async () => {
    const seen: string[] = [];
    const result = await findRecruiters({ company: 'Nuro', canonicalUrl: 'https://nuro.ai/x' }, { key: 'k', fetch: fakeFetch(hunterBody, 200, seen) });
    expect(seen[0]).toContain('domain=nuro.ai');
    expect(seen[0]).toContain('department=hr');
    expect(result).toMatchObject({ lookup: 'ok', domain: 'nuro.ai' });
    expect(result.people).toEqual([
      { name: 'Sam Kim', title: 'University Recruiter', email: 'sam@nuro.ai', linkedin: 'https://www.linkedin.com/in/samkim' },
      { name: 'Pat Lee', title: 'HR Business Partner', email: 'pat@nuro.ai', linkedin: null },
      { name: null, title: null, email: 'alex@nuro.ai', linkedin: 'https://www.linkedin.com/in/alexr' },
    ]);
  });

  it('falls back to the company name when the posting sits on an ATS', async () => {
    const seen: string[] = [];
    await findRecruiters({ company: 'Acme Robotics', canonicalUrl: 'https://boards.greenhouse.io/acme/jobs/1' }, { key: 'k2', fetch: fakeFetch(hunterBody, 200, seen) });
    expect(seen[0]).toContain('company=Acme+Robotics');
    expect(seen[0]).not.toContain('domain=');
  });

  it('reports Hunter failures as unavailable, never throws', async () => {
    const result = await findRecruiters({ company: 'Nuro', canonicalUrl: 'https://nuro.ai/y' }, { key: 'k3', fetch: fakeFetch({ errors: [] }, 429) });
    expect(result).toMatchObject({ lookup: 'unavailable', people: [] });
  });
});
