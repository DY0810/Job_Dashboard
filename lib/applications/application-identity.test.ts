import { describe, expect, it } from 'vitest';
import { resolveApplicationIdentity } from './application-identity.ts';
import { ApplicationIdentitySchema } from './worker-protocol.ts';

const uuid = '5aada5a7-6ef3-4776-8aee-d02ddf9c19c0';
const gh = 'https://job-boards.greenhouse.io/acme/jobs/123';
const source = (sourceUrl: string, publisherId: string | null = null, name = 'greenhouse') =>
  ({ source: name, sourceUrl, publisherId });

describe('official application identity, never a receipt or collector identity', () => {
  it.each([
    [gh, 'greenhouse', 'acme', '123'],
    [`https://jobs.ashbyhq.com/acme/${uuid}/application`, 'ashby', 'acme', uuid],
    [`https://jobs.lever.co/acme/${uuid}/apply`, 'lever', 'acme', uuid],
    ['https://jobs.jobvite.com/acme/job/oAbC1234/apply', 'jobvite', 'acme', 'oAbC1234'],
    ['https://nvidia.wd5.myworkdayjobs.com/en-US/External/job/US/Engineer_JR2022939-1',
      'workday', 'nvidia.wd5.myworkdayjobs.com', 'JR2022939-1'],
    ['https://egug.fa.us2.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/26012000',
      'oracle', 'egug.fa.us2.oraclecloud.com', '26012000'],
    ['https://careers-test774.icims.com/jobs/1000/job?iis=board',
      'icims', 'careers-test774.icims.com', '1000'],
  ])('resolves the exact tenant and native URL identifier: %s', (url, ats, tenant, requisition) => {
    expect(resolveApplicationIdentity(url, [])).toMatchObject({
      status: 'resolved', identity: { ats, tenant, requisition },
    });
  });

  it('collapses Greenhouse host/embed aliases and retains the original evidence', () => {
    const alias = 'https://boards.greenhouse.io/acme/jobs/123?gh_src=board#application';
    const embedded = 'https://boards.greenhouse.io/embed/job_app?for=acme&token=123';
    const result = resolveApplicationIdentity(gh, [source(alias, '123'), source(embedded, '123')]);
    expect(result.status).toBe('resolved');
    expect(result.aliases).toEqual([gh, alias, embedded].sort());
    expect(result.officialUrl).toBe(gh);
  });

  it.each([
    'https://job-boards.greenhouse.io.evil.test/acme/jobs/123',
    'https://job-boards.greenhouse.io@evil.test/acme/jobs/123',
    'https://user@job-boards.greenhouse.io/acme/jobs/123',
    'https://job-boards.greenhouse.io:444/acme/jobs/123',
    'http://job-boards.greenhouse.io/acme/jobs/123',
    'https://job-boards.greenhouse.io/acme/jobs/123/other',
    'https://job-boards.greenhouse.io/acme%2fother/jobs/123',
    'https://job-boards.greenhouse.io/acme/jobs/%31%32%33',
    'https://careers-a.icims.com.evil.test/jobs/1000/job',
    'https://acme.myworkdayjobs.com/job/US/Engineer_R1',
    'https://acme.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1/job/123',
    'https://jobs.lever.co/acme/not-a-posting-id',
    'not a url',
  ])('does not trust unsupported/spoofed URL %s or a bare publisher ID', (url) => {
    expect(resolveApplicationIdentity(url, [source(url, '123')])).toMatchObject({
      status: 'unresolved', identity: null, officialUrl: null,
    });
  });

  it.each([
    source('https://boards.greenhouse.io/acme/jobs/124', '124'),
    source('https://boards.greenhouse.io/other/jobs/123', '123'),
    source(gh, '999'),
    source('https://boards.greenhouse.io/embed/job_app?for=acme&token=123&token=999'),
  ])('holds conflicting native evidence without picking a winner', (other) => {
    const result = resolveApplicationIdentity(gh, [other]);
    expect(result.status).toBe('conflict');
    expect(result.identity).toBeNull();
    expect(result.officialUrl).toBeNull();
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it('ignores unrelated aggregator ID namespaces and accepts the old URL fallback', () => {
    expect(resolveApplicationIdentity(gh, [source(gh, 'feed-77', 'simplify-internships')]).status).toBe('resolved');
    expect(resolveApplicationIdentity(gh, [source(gh, `${gh}?utm_source=old`)]).status).toBe('resolved');
  });

  it('does not strip Workday suffixes or substitute a collector ID', () => {
    const url = 'https://nvidia.wd5.myworkdayjobs.com/External/job/US/Engineer_JR2022939-1';
    expect(resolveApplicationIdentity(url, [source(url, 'JR2022939', 'workday')]).status).toBe('conflict');
  });

  it('keeps distinct region/host namespaces and case-sensitive requisitions separate', () => {
    const us = resolveApplicationIdentity(`https://jobs.lever.co/acme/${uuid}`, []);
    const eu = resolveApplicationIdentity(`https://jobs.eu.lever.co/acme/${uuid}`, []);
    expect(us.identity).not.toEqual(eu.identity);
    expect(ApplicationIdentitySchema.safeParse(eu.identity).success).toBe(true);
    expect(resolveApplicationIdentity('https://jobs.jobvite.com/acme/job/oAbC', []).identity)
      .not.toEqual(resolveApplicationIdentity('https://jobs.jobvite.com/acme/job/oabc', []).identity);
  });

  it('holds unsupported oversized or invalid tenant IDs instead of breaking the worker/import DTO', () => {
    for (const tenant of ['_acme', 'a'.repeat(257)]) {
      expect(resolveApplicationIdentity(`https://job-boards.greenhouse.io/${tenant}/jobs/123`, []).status)
        .toBe('unresolved');
    }
  });
});
