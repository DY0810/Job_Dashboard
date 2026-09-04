import { describe, expect, it } from 'vitest';

import { compose, composeUrl, type Posting, type Sender } from './outreach.ts';

const SENDER: Sender = { name: 'A Person', intro: 'I study X and build Y.' };
const POSTING: Posting = {
  company: 'Northline',
  title: 'Software Engineer Intern',
  canonicalUrl: 'https://boards.greenhouse.io/northline/jobs/1',
};

describe('composeUrl', () => {
  /**
   * The whole reason this function exists rather than a template literal at the call site.
   * `&` truncates the subject at that character and `#` makes everything after it a fragment
   * the server never receives — and 1,600 live titles contain `&`.
   */
  it('survives the characters real job titles actually contain', () => {
    const nasty = 'Engineer, C++ & Rust (100% Remote) — Summer #2';
    const url = new URL(composeUrl(nasty, 'body'));
    expect(url.searchParams.get('su')).toBe(nasty);
  });

  it('round-trips a body with blank lines, so paragraphs survive the handoff', () => {
    const body = 'First line.\n\nSecond paragraph.\n\nSigned';
    expect(new URL(composeUrl('s', body)).searchParams.get('body')).toBe(body);
  });

  it('leaves the recipient empty — there is nothing honest to put there', () => {
    // 62% of canonical URLs are on an ATS host, so the registrable domain is Greenhouse or
    // Ashby rather than the employer; harvesting addresses out of descriptions hits an
    // accommodations inbox 85% of the time. An empty To: is the correct handoff.
    expect(new URL(composeUrl('s', 'b')).searchParams.get('to')).toBe('');
  });

  it('does not pin a Google account', () => {
    // `/mail/u/0/` would target whichever account signed in first.
    expect(composeUrl('s', 'b')).not.toContain('/u/0/');
  });
});

describe('compose', () => {
  it.each(['coffee', 'referral'] as const)('%s names the posting and links it', (kind) => {
    const { subject, body } = compose(kind, POSTING, SENDER);
    expect(subject.length).toBeGreaterThan(0);
    expect(body).toContain(POSTING.company);
    expect(body).toContain(POSTING.canonicalUrl);
    expect(body.trimEnd().endsWith(SENDER.name)).toBe(true);
  });

  /**
   * The résumé has two live versions of six claims and of the graduation year, and the year
   * is an eligibility filter that must match every other surface exactly. A template that
   * states either would contradict a résumé already sent, so no template states any.
   */
  it.each(['coffee', 'referral'] as const)('%s states no contested résumé fact', (kind) => {
    const { subject, body } = compose(kind, POSTING, SENDER);
    const text = `${subject}\n${body}`;
    expect(text).not.toMatch(/\b20\d\d\b/); // no graduation or cohort year
    expect(text).not.toMatch(/\d+\s*(?:ms|%|x\b)/i); // no latency, accuracy or multiple
    expect(text).not.toMatch(/\$\d/); // no cost-per-minute
  });

  it.each(['coffee', 'referral'] as const)('%s stays under the length a stranger reads', (kind) => {
    const words = compose(kind, POSTING, SENDER).body.trim().split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(150);
  });

  /**
   * The bracketed slots are the feature, not an oversight: a draft that needs no typing is
   * the merge-field email that gets deleted. Both templates must refuse to be sendable
   * as-is.
   */
  it.each(['coffee', 'referral'] as const)('%s leaves a human slot unfilled', (kind) => {
    expect(compose(kind, POSTING, SENDER).body).toMatch(/\[[^\]]+\]/);
  });

  it('drops a subject-line title too long for Gmail to show whole', () => {
    const long = { ...POSTING, title: 'Software Engineer Intern, Platform Infrastructure and Developer Experience, Summer Cohort' };
    expect(compose('coffee', long, SENDER).subject).toBe('Coffee chat — 15 minutes?');
    // ...but the full title still appears in the body, where nothing truncates it.
    expect(compose('coffee', long, SENDER).body).toContain(long.title);
  });

  it('carries the sender through, so two people sharing one board sign as themselves', () => {
    const other = { name: 'Someone Else', intro: 'Different background entirely.' };
    expect(compose('coffee', POSTING, other).body).toContain(other.intro);
    expect(compose('coffee', POSTING, other).body).not.toContain(SENDER.intro);
  });
});
