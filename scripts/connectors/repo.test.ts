import { describe, expect, it } from 'vitest';
import { extract } from '../../lib/extract.ts';
import type { ConnectorContext, Runtime } from '../../lib/runtime.ts';
import { additionalRepoConnectors, parseRepositoryTables, repositoryDate } from './repo.ts';

const NOW = Date.parse('2026-09-14T12:00:00Z');
const table = (headers: string[], rows: string[][]) =>
  `<table><thead><tr>${headers.map((value) => `<th>${value}</th>`).join('')}</tr></thead><tbody>`
  + rows.map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join('')}</tr>`).join('')
  + '</tbody></table>';
const apply = (url: string) => `<a href="${url}"><img alt="Apply" src="https://images.test/button.png"></a>`;

describe('repository table feeds', () => {
  it('reads Vansh rows, carries companies, preserves locations, and skips explicit closures', () => {
    const html = table(['Company', 'Role', 'Location', 'Application/Link', 'Date Posted'], [
      ['Acme &amp; Co.', 'Software Engineer Intern', '<details><summary>2 locations</summary>Los Angeles, CA<br>San Francisco, CA</details>',
        apply('https://employer.test/jobs/100001?utm_source=github&amp;ref=requisition-1'), 'Aug 21'],
      ['&#x21b3;', 'Data Science Intern', 'Remote', apply('https://employer.test/jobs/100002'), 'Aug 20'],
      ['&#x21b3;', 'Closed role', 'Remote', '&#x1f512;', 'Aug 19'],
    ]);
    const result = parseRepositoryTables(html, NOW, 'vansh-internships');
    expect(result.invalidRows).toBe(0);
    expect(result.postings).toHaveLength(2);
    expect(result.postings.map((row) => row.company)).toEqual(['Acme & Co.', 'Acme & Co.']);
    expect(result.postings[0]).toMatchObject({
      source: 'vansh-internships', sourceKind: 'repo',
      sourceUrl: 'https://employer.test/jobs/100001?ref=requisition-1',
      location: 'Los Angeles, CA; San Francisco, CA',
      postedAt: Date.parse('2026-08-21T00:00:00Z'), description: '',
    });
    expect(result.postings[0].publisherId).not.toBe(result.postings[1].publisherId);
  });

  it('keeps the SpeedyApply salary as supplied and does not infer pay when absent', () => {
    const result = parseRepositoryTables(table(['Company', 'Position', 'Location', 'Salary', 'Posting', 'Age'], [
      ['<a href="https://company.test"><strong>Acme</strong></a>', 'Software Engineer Intern', 'Austin, TX', '$35/hr',
        apply('https://employer.test/jobs/1'), '2d'],
      ['Acme', 'Software Engineer, New Grad', 'Remote', '-', apply('https://employer.test/jobs/2'), '1mo'],
    ]), NOW, 'speedyapply-swe');
    expect(result.postings).toHaveLength(2);
    const [paid, unknown] = result.postings.map((row) => extract({
      title: row.title!, description: row.description, sourceFields: row.sourceFields,
    }));
    expect(paid).toMatchObject({ paid: true, pay_rate: { min: 35, max: null, period: 'hour' } });
    expect(unknown.paid).toBeNull();
    expect(result.postings[0].postedAt).toBe(NOW - 2 * 86_400_000);
  });

  it('takes Jobright job links from the title, never LinkedIn company links', () => {
    const result = parseRepositoryTables(table(['Company', 'Job Title', 'Location', 'Work Model', 'Date Posted'], [
      ['<a href="https://www.linkedin.com/company/acme"><strong>Acme</strong></a>',
        '<strong><a href="https://jobright.ai/jobs/info/0123456789abcdef01234567?utm_campaign=1049">UX Design Intern</a></strong>',
        'Toronto, ON, Canada', 'Remote', 'Sep 13'],
    ]), NOW, 'jobright-design');
    expect(result.postings[0]).toMatchObject({
      company: 'Acme', title: 'UX Design Intern',
      sourceUrl: 'https://jobright.ai/jobs/info/0123456789abcdef01234567',
      publisherId: 'https://jobright.ai/jobs/info/0123456789abcdef01234567',
      description: '', sourceFields: { workMode: 'remote', location: 'Toronto, ON, Canada' },
    });
  });

  it('does not turn missing or unsafe application links into postings', () => {
    const result = parseRepositoryTables(table(['Company', 'Role', 'Location', 'Application/Link', 'Date Posted'], [
      ['Acme', 'Designer', 'Remote', apply('javascript:alert(1)'), 'Sep 13'],
      ['Acme', 'Designer', 'Remote', apply('https://user:password@employer.test/job/2'), 'Sep 13'],
      ['Acme', 'Designer', 'Remote', apply('https://www.linkedin.com/jobs/view/123456'), 'Sep 13'],
      ['Acme', 'Designer', 'Remote', 'Apply', 'Sep 13'],
    ]), NOW, 'vansh-internships');
    expect(result.postings).toEqual([]);
    expect(result.invalidRows).toBe(4);
  });

  it('handles year rollover without using the internship start year as the posting year', () => {
    expect(repositoryDate('Dec 31', Date.parse('2027-01-02T12:00:00Z'))).toBe(Date.parse('2026-12-31T00:00:00Z'));
    expect(repositoryDate('Aug 21', NOW)).toBe(Date.parse('2026-08-21T00:00:00Z'));
    expect(repositoryDate('2026-09-12', NOW)).toBe(Date.parse('2026-09-12T00:00:00Z'));
    expect(Number.isNaN(repositoryDate('Feb 30', NOW))).toBe(true);
    expect(Number.isNaN(repositoryDate('unknown', NOW))).toBe(true);
  });
});

describe('repository registration and isolation', () => {
  it('registers every requested repository separately', () => {
    expect(additionalRepoConnectors.map((connector) => connector.name)).toEqual([
      'vansh-internships', 'speedyapply-ai', 'speedyapply-swe',
      'jobright-software', 'jobright-engineering', 'jobright-marketing', 'jobright-design', 'jobright-art',
    ]);
    expect(additionalRepoConnectors.every((connector) => connector.minIntervalMs === 3 * 60 * 60 * 1000)).toBe(true);
  });

  it('fetches only GitHub, keeps successful files, and prevents absence-based delisting', async () => {
    const urls: string[] = [];
    const degraded: string[] = [];
    const runtime: Runtime = {
      fetchText: async (url, options) => {
        urls.push(url);
        expect(options?.headers).toMatchObject({ Accept: 'application/vnd.github.html+json' });
        if (url.includes('INTERN_INTL.md')) throw new Error('temporary failure');
        return table(['Company', 'Position', 'Location', 'Salary', 'Posting', 'Age'], [
          ['Acme', 'Software Engineer Intern', 'Remote', '-', apply('https://employer.test/job/1'), '0d'],
        ]);
      },
      fetchJson: async () => { throw new Error('rendered tables are not JSON'); },
      isAllowed: async () => true,
    };
    const context: ConnectorContext = { runtime, env: {}, log: () => {}, degraded: (reason) => { degraded.push(reason); } };
    const result = await additionalRepoConnectors.find((connector) => connector.name === 'speedyapply-swe')!.fetch(context);
    expect(result.length).toBeGreaterThan(0);
    expect(urls).toHaveLength(4);
    expect(urls.every((url) => url.startsWith('https://api.github.com/repos/speedyapply/2027-SWE-College-Jobs/contents/'))).toBe(true);
    expect(degraded.some((reason) => /snapshot/i.test(reason))).toBe(true);
    expect(degraded.some((reason) => reason.includes('INTERN_INTL.md'))).toBe(true);
    context.env = { GITHUB_TOKEN: 'test-only-token' };
    runtime.fetchText = async (_url, options) => {
      expect(options?.headers).toMatchObject({ Authorization: 'Bearer test-only-token' });
      throw new Error('temporary failure');
    };
    await expect(additionalRepoConnectors[0].fetch(context)).rejects.toThrow(/temporary failure/);
  });
});
