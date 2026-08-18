import { describe, expect, it } from 'vitest';

import { dedupePostings, type RawPosting } from './dedupe.ts';

/**
 * GOLDEN CORPUS — one job, five source shapes.
 *
 * A single Greenhouse-hosted posting (Figma · Product Designer · San Francisco) as it
 * appears syndicated across four aggregators. The payloads below are hand-transcribed in
 * each platform's real field shape — Greenhouse escapes its HTML into `content`, RemoteOK
 * reports `epoch` seconds and a bare "Remote", Remotive splits company into `company_name`
 * and location into `candidate_required_location`, We Work Remotely encodes the company in
 * the RSS `<title>`, and SimplifyJobs is a markdown table row.
 *
 * The adapters below are deliberately test-local: turning a payload into a `RawPosting` is
 * connector work (P3/P6). All this file asserts is that once the five shapes reach the
 * dedupe engine, they collapse to exactly one posting with five sources.
 */

const GREENHOUSE_JOB = {
  absolute_url: 'https://boards.greenhouse.io/figma/jobs/4567890',
  internal_job_id: 1234567,
  id: 4567890,
  location: { name: 'San Francisco, CA' },
  metadata: [],
  requisition_id: 'REQ-1042',
  title: 'Product Designer',
  updated_at: '2026-07-29T11:02:14-04:00',
  first_published: '2026-07-28T16:04:00-04:00',
  content:
    '&lt;p&gt;We are looking for a Product Designer.&lt;/p&gt;&lt;h3&gt;Responsibilities&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Ship design systems&lt;/li&gt;&lt;/ul&gt;',
};

const REMOTEOK_JOB = {
  slug: 'product-designer-figma',
  id: '1098234',
  epoch: 1785332400, // 2026-07-29T13:40:00Z
  date: '2026-07-29T13:40:00+00:00',
  company: 'Figma Inc.',
  company_logo: 'https://remoteok.com/assets/img/jobs/figma.png',
  position: 'Product Designer (Remote)',
  tags: ['design', 'figma', 'product'],
  location: 'Remote',
  url: 'https://remoteok.com/remote-jobs/1098234-product-designer-figma',
  apply_url: 'https://remoteok.com/l/1098234',
  description: '<p>We are looking for a Product Designer.</p>',
};

const REMOTIVE_JOB = {
  id: 2145522,
  url: 'https://remotive.com/remote-jobs/design/product-designer-2145522',
  title: 'Product Designer',
  company_name: 'Figma, Inc.',
  company_logo: 'https://remotive.com/job/2145522/logo',
  category: 'Design',
  tags: ['design', 'product'],
  job_type: 'full_time',
  publication_date: '2026-07-29T09:12:33', // Remotive omits the offset; it is UTC
  candidate_required_location: 'USA',
  salary: '',
  description: '<p>We are looking for a Product Designer.</p>',
};

const WWR_RSS_ITEM = `<item>
  <title>Figma: Product Designer</title>
  <region>Anywhere in the World</region>
  <category>Design</category>
  <type>Full-Time</type>
  <link>https://weworkremotely.com/remote-jobs/figma-product-designer</link>
  <pubDate>Thu, 30 Jul 2026 14:22:11 +0000</pubDate>
  <description>&lt;p&gt;We are looking for a Product Designer.&lt;/p&gt;</description>
</item>`;

const SIMPLIFY_README_ROW =
  '| **Figma** | Product Designer | San Francisco, CA | <a href="https://boards.greenhouse.io/figma/jobs/4567890?utm_source=Simplify&utm_medium=Simplify"><img src="https://i.imgur.com/w6lyvuC.png" width="84" alt="Apply"></a> | Jul 30 |';

const fromGreenhouse = (job: typeof GREENHOUSE_JOB): RawPosting => ({
  source: 'greenhouse',
  sourceKind: 'ats',
  sourceUrl: job.absolute_url,
  postedAt: Date.parse(job.first_published),
  company: 'Figma', // the ATS payload has no company field; the connector registry supplies it
  title: job.title,
  location: job.location.name,
});

const fromRemoteOk = (job: typeof REMOTEOK_JOB): RawPosting => ({
  source: 'remoteok',
  sourceKind: 'aggregator',
  sourceUrl: job.url,
  postedAt: job.epoch * 1000,
  company: job.company,
  title: job.position,
  location: job.location,
});

const fromRemotive = (job: typeof REMOTIVE_JOB): RawPosting => ({
  source: 'remotive',
  sourceKind: 'aggregator',
  sourceUrl: job.url,
  postedAt: Date.parse(`${job.publication_date}Z`),
  company: job.company_name,
  title: job.title,
  // Remotive is a remote-only board; the field carries eligibility, not an office.
  location: `Remote, ${job.candidate_required_location}`,
});

const fromWwrRssItem = (xml: string): RawPosting => {
  const tag = (name: string) =>
    new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml)?.[1].trim() ?? '';
  const [company, title] = tag('title').split(':');
  return {
    source: 'weworkremotely',
    sourceKind: 'rss',
    sourceUrl: tag('link'),
    postedAt: Date.parse(tag('pubDate')),
    company,
    title,
    location: tag('region'),
  };
};

const fromSimplifyRow = (row: string, year: number): RawPosting => {
  const [company, title, location, apply, date] = row
    .split('|')
    .slice(1, -1)
    .map((cell) => cell.trim());
  return {
    source: 'simplify-internships',
    sourceKind: 'repo',
    sourceUrl: /href="([^"]+)"/.exec(apply)?.[1] ?? '',
    postedAt: Date.parse(`${date} ${year} UTC`),
    company: company.replaceAll('*', ''),
    title,
    location,
  };
};

describe('golden corpus: one job, five source shapes', () => {
  const shapes: RawPosting[] = [
    fromGreenhouse(GREENHOUSE_JOB),
    fromRemoteOk(REMOTEOK_JOB),
    fromRemotive(REMOTIVE_JOB),
    fromWwrRssItem(WWR_RSS_ITEM),
    fromSimplifyRow(SIMPLIFY_README_ROW, 2026),
  ];

  it('collapses to exactly one posting', () => {
    expect(dedupePostings(shapes)).toHaveLength(1);
  });

  it('keeps one source row per shape', () => {
    const [merged] = dedupePostings(shapes);
    expect(merged.sources).toHaveLength(5);
    expect(merged.sources.map((s) => s.source).sort()).toEqual([
      'greenhouse',
      'remoteok',
      'remotive',
      'simplify-internships',
      'weworkremotely',
    ]);
    expect(new Set(merged.sources.map((s) => s.sourceUrl)).size).toBe(5);
  });

  it('points canonical_url at Greenhouse', () => {
    const [merged] = dedupePostings(shapes);
    expect(merged.canonicalUrl).toBe(GREENHOUSE_JOB.absolute_url);
  });

  it('takes posted_at from the earliest source', () => {
    const [merged] = dedupePostings(shapes);
    expect(merged.postedAt).toBe(Date.parse('2026-07-28T20:04:00Z'));
    expect(merged.postedAt).toBe(Math.min(...shapes.map((s) => s.postedAt)));
  });

  it('keeps each source posted_at untouched', () => {
    const [merged] = dedupePostings(shapes);
    const byName = Object.fromEntries(merged.sources.map((s) => [s.source, s.postedAt]));
    expect(byName.remoteok).toBe(Date.parse('2026-07-29T13:40:00Z'));
    expect(byName.remotive).toBe(Date.parse('2026-07-29T09:12:33Z'));
    expect(byName.weworkremotely).toBe(Date.parse('2026-07-30T14:22:11Z'));
  });

  it('keeps the ATS location as truth', () => {
    const [merged] = dedupePostings(shapes);
    expect(merged.location).toEqual({
      city_norm: 'sf',
      state: 'CA',
      country: 'US',
      is_remote: false,
    });
    expect(merged.companyNorm).toBe('figma');
    expect(merged.titleNorm).toBe('product designer');
  });

  it('is order-independent', () => {
    const reversed = dedupePostings([...shapes].reverse());
    expect(reversed).toHaveLength(1);
    expect(reversed[0].dedupeKey).toBe(dedupePostings(shapes)[0].dedupeKey);
    expect(reversed[0].canonicalUrl).toBe(GREENHOUSE_JOB.absolute_url);
    expect(reversed[0].postedAt).toBe(Date.parse('2026-07-28T20:04:00Z'));
  });
});
