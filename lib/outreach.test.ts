import { describe, expect, it } from 'vitest';

import { compose, composeUrl, type Posting, type Recipient, type Sender } from './outreach.ts';

const SENDER: Sender = { name: 'A Person', intro: 'I study X and build Y.' };
const TO: Recipient = { name: 'Sarah Okafor', email: 'sarah@northline.com' };
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
    const url = new URL(composeUrl(TO.email, nasty, 'body'));
    expect(url.searchParams.get('su')).toBe(nasty);
  });

  it('round-trips a body with blank lines, so paragraphs survive the handoff', () => {
    const body = 'First line.\n\nSecond paragraph.\n\nSigned';
    expect(new URL(composeUrl(TO.email, 's', body)).searchParams.get('body')).toBe(body);
  });

  it('addresses the draft to the person you typed', () => {
    // Workie still finds nobody — 62% of canonical URLs are ATS hosts so no employer domain
    // is derivable, and 85% of addresses in descriptions are accommodations inboxes. The
    // address is typed by a human looking at the person; this only saves re-typing it.
    expect(new URL(composeUrl('a+b@sub.example.com', 's', 'b')).searchParams.get('to')).toBe(
      'a+b@sub.example.com',
    );
  });

  it('does not pin a Google account', () => {
    // `/mail/u/0/` would target whichever account signed in first.
    expect(composeUrl(TO.email, 's', 'b')).not.toContain('/u/0/');
  });
});

describe('compose', () => {
  it.each(['coffee', 'referral'] as const)('%s names the posting and links it', (kind) => {
    const { subject, body } = compose(kind, POSTING, SENDER, TO);
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
    const { subject, body } = compose(kind, POSTING, SENDER, TO);
    const text = `${subject}\n${body}`;
    expect(text).not.toMatch(/\b20\d\d\b/); // no graduation or cohort year
    expect(text).not.toMatch(/\d+\s*(?:ms|%|x\b)/i); // no latency, accuracy or multiple
    expect(text).not.toMatch(/\$\d/); // no cost-per-minute
  });

  /**
   * A bound, not a finding. Every measured claim about optimal cold-email word count failed
   * verification — there is no evidenced optimum, and this file must not imply one. 150 is
   * craft: it keeps the draft inside a phone screen. Asserted only so a future edit cannot
   * quietly grow the templates into something nobody reads.
   */
  it.each(['coffee', 'referral'] as const)('%s stays inside the craft length bound', (kind) => {
    const words = compose(kind, POSTING, SENDER, TO).body.trim().split(/\s+/).length;
    expect(words).toBeLessThanOrEqual(150);
  });

  it.each(['coffee', 'referral'] as const)('%s greets the recipient by first name', (kind) => {
    expect(compose(kind, POSTING, SENDER, TO).body.startsWith('Hi Sarah —')).toBe(true);
  });

  /**
   * The one thing the evidence base actually settles. A pre-registered RCT across 238 stores
   * found referral supply rationed by the referrer's willingness to attach their NAME —
   * bonuses bought more referrals of worse quality. So the ask owes them underwriting
   * material, not rapport: the specific requisition plus concrete evidence they would be
   * right about you.
   */
  it('the referral ask supplies underwriting material, not rapport', () => {
    const body = compose('referral', POSTING, SENDER, TO).body;
    expect(body).toContain(POSTING.canonicalUrl); // the specific requisition
    expect(body.match(/^- \[/gm)?.length ?? 0).toBeGreaterThanOrEqual(3); // evidence of fit
    expect(body).toMatch(/put your name on it/i); // names what is actually being spent
  });

  /**
   * Every measured referral finding concerns someone the referrer already knows, and nothing
   * measured says a stranger referral converts. The template encodes that structurally: it
   * opens on a prior conversation and is unsendable without one.
   */
  it('the referral ask cannot be sent to a stranger', () => {
    expect(compose('referral', POSTING, SENDER, TO).body).toMatch(/Thanks again for \[/);
  });

  /**
   * The bracketed slots are the feature, not an oversight: a draft that needs no typing is
   * the merge-field email that gets deleted. Both templates must refuse to be sendable
   * as-is.
   */
  it.each(['coffee', 'referral'] as const)('%s leaves a human slot unfilled', (kind) => {
    expect(compose(kind, POSTING, SENDER, TO).body).toMatch(/\[[^\]]+\]/);
  });

  it('drops a subject-line title too long for Gmail to show whole', () => {
    const long = { ...POSTING, title: 'Software Engineer Intern, Platform Infrastructure and Developer Experience, Summer Cohort' };
    expect(compose('coffee', long, SENDER, TO).subject).toBe('Coffee chat — 15 minutes?');
    // ...but the full title still appears in the body, where nothing truncates it.
    expect(compose('coffee', long, SENDER, TO).body).toContain(long.title);
  });

  it('carries the sender through, so two people sharing one board sign as themselves', () => {
    const other = { name: 'Someone Else', intro: 'Different background entirely.' };
    expect(compose('coffee', POSTING, other, TO).body).toContain(other.intro);
    expect(compose('coffee', POSTING, other, TO).body).not.toContain(SENDER.intro);
  });
});
