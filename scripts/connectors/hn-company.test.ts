/**
 * The heuristic HN extractor. Inputs below are the real comment shapes from the August 2026
 * "Who is hiring?" thread, entity-encoding and all.
 *
 * The contract under test is PRECISION, not recall: `company` is a dedupe-key component, so
 * a wrong answer creates a phantom posting that can never merge with the same job's ATS row.
 * Every "returns null" case below is the extractor doing its job, not a gap.
 */

import { describe, expect, it } from 'vitest';

import { heuristicExtractor } from './hn-company.ts';
import { hnConnector } from './agg.ts';
import { fixtureRuntime, loadFixture } from './fixtures.ts';

describe('heuristicExtractor', () => {
  it('reads the conventional pipe-delimited head line', async () => {
    const result = await heuristicExtractor(
      'Snout <a href="https:&#x2F;&#x2F;snout.com&#x2F;" rel="nofollow">https:&#x2F;&#x2F;snout.com&#x2F;</a> | Multiple Engineering + Product Roles | Remote US or Ontario, Canada | Full Time<p>Join us at Snout on our mission...',
    );
    expect(result?.company).toBe('Snout');
    expect(result?.title).toBe('Multiple Engineering + Product Roles');
    expect(result?.location).toBe('Remote US or Ontario, Canada');
  });

  it('skips non-role segments to find the role', async () => {
    const result = await heuristicExtractor(
      'PostHog | Full-Time | Technical CSMs, Technical AEs, AI Research Engineer | REMOTE (all remote) | Hiring GMT-8 to GMT+2',
    );
    expect(result?.company).toBe('PostHog');
    expect(result?.title).toBe('Technical CSMs, Technical AEs, AI Research Engineer');
  });

  it('strips a funding-stage parenthetical from the company', async () => {
    const result = await heuristicExtractor(
      'Kyra Health (Series B) | Senior &amp; Staff Product Engineers | Python &#x2F; TypeScript | Remote (USA)',
    );
    expect(result?.company).toBe('Kyra Health');
  });

  it('returns null when the poster used no delimiters at all', async () => {
    expect(
      await heuristicExtractor(
        'Flywheel Motion (<a href="https:&#x2F;&#x2F;flywheelmotion.com&#x2F;">link</a>)<p>We are hiring.',
      ),
    ).toBeNull();
  });

  it('returns null when no segment looks like a role', async () => {
    expect(
      await heuristicExtractor('Shepherd (Series B) | ONSITE | San Francisco, CA &amp; New York City, NY'),
    ).toBeNull();
  });

  it('refuses to treat a job title as a company', async () => {
    expect(await heuristicExtractor('Senior Backend Engineer | Remote | Full Time')).toBeNull();
  });

  it('refuses a work-mode or benefit word as a company', async () => {
    expect(await heuristicExtractor('REMOTE | Software Engineer | $150k')).toBeNull();
    expect(await heuristicExtractor('Full-Time | Software Engineer | NYC')).toBeNull();
  });

  it('refuses a sentence', async () => {
    expect(
      await heuristicExtractor(
        'We are a small team and we are looking for help | Software Engineer | Remote',
      ),
    ).toBeNull();
  });

  it('refuses a bare URL as a company', async () => {
    expect(
      await heuristicExtractor(
        '<a href="https:&#x2F;&#x2F;example.com">https:&#x2F;&#x2F;example.com</a> | Software Engineer | Remote',
      ),
    ).toBeNull();
  });

  it('never lets an unrecognized segment become a location', async () => {
    // "Full Time" must not end up as a city, or the dedupe key splits against the ATS row.
    const result = await heuristicExtractor('Acme | Software Engineer | Full Time | Perks');
    expect(result?.location).toBeNull();
  });
});

describe('extractor injection', () => {
  it('the connector takes any extractor, so the cached-Haiku one drops straight in', async () => {
    const connector = hnConnector(async () => ({
      company: 'Injected Co',
      title: 'Staff Engineer',
      location: 'Remote',
    }));
    const results = await connector.fetch({
      runtime: fixtureRuntime(loadFixture('hn')),
      env: {},
      log: () => {},
    });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((posting) => posting.company === 'Injected Co')).toBe(true);
  });

  it('an extractor that declines drops the row rather than inventing a company', async () => {
    const connector = hnConnector(async () => null);
    const results = await connector.fetch({
      runtime: fixtureRuntime(loadFixture('hn')),
      env: {},
      log: () => {},
    });
    expect(results).toEqual([]);
  });
});
