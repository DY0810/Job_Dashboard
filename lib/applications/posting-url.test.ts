import { describe, expect, it } from 'vitest';
import { postingUrl } from './posting-url.ts';

describe('postingUrl', () => {
  it.each([
    ['greenhouse', 'acme', '123', 'https://job-boards.greenhouse.io/acme/jobs/123'],
    ['ashby', 'acme', 'abc-1', 'https://jobs.ashbyhq.com/acme/abc-1'],
    ['lever', 'acme', 'abc-1', 'https://jobs.lever.co/acme/abc-1'],
    ['lever', 'jobs.eu.lever.co:acme', 'abc-1', 'https://jobs.eu.lever.co/acme/abc-1'],
    ['workday', 'acme.wd5.myworkdayjobs.com', 'JR1', null],
  ])('%s %s %s', (ats, tenant, requisition, url) => {
    expect(postingUrl(ats, tenant, requisition)).toBe(url);
  });
});
