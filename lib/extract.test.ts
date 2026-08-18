/**
 * Extraction tests. Deterministic by construction — no stub client, no network, no key,
 * because there is no model. Every assertion is a hand-authored expectation from
 * `extract.fixtures.ts`, never a recording of what the implementation happens to return.
 */

import { describe, expect, it } from 'vitest';

import {
  extract,
  extractSummary,
  isSeniorByRegex,
  parseSections,
  toStored,
  type ExtractInput,
} from './extract.ts';
import { GRADED_FIELDS, POSTING_FIXTURES, SENIOR_FIXTURES } from './extract.fixtures.ts';
import { normalizeDescription } from './normalize.ts';
import { VOICE_BADGE } from './voice.ts';

function run(fixture: { title: string; description: string }, sourceFields?: ExtractInput['sourceFields']) {
  return extract({
    title: fixture.title,
    description: normalizeDescription(fixture.description),
    sourceFields,
  });
}

// ---------------------------------------------------------------------------------------
// Seniority — the acceptance criterion, with no model behind it any more
// ---------------------------------------------------------------------------------------

describe('seniority', () => {
  it('covers every senior fixture with zero leaks', () => {
    for (const fixture of SENIOR_FIXTURES) {
      const seniority = run(fixture).seniority;
      expect(seniority, `${fixture.title} — ${fixture.company}`).toBe('senior+');
    }
    expect(SENIOR_FIXTURES.length).toBeGreaterThanOrEqual(15);
  });

  it('keeps every listed posting — no false positives on the fixture set', () => {
    for (const fixture of POSTING_FIXTURES) {
      expect(run(fixture).seniority, fixture.title).not.toBe('senior+');
    }
  });

  /**
   * THE REGRESSION. A years range has to be read from its START: "2-5 years" is the standard
   * way to write a mid-level ask. Reading the tail instead — which a bare `\b[5-9]` does,
   * since a hyphen is a word boundary — silently drops most mid roles. Found and fixed once.
   */
  it('reads a years range from its start, so the mid band survives', () => {
    expect(isSeniorByRegex('Software Engineer', 'We want 2-5 years of experience.')).toBe(false);
    expect(isSeniorByRegex('Software Engineer', 'We want 5-7 years of experience.')).toBe(true);
    expect(isSeniorByRegex('Software Engineer', 'We want 3 to 6 years of experience.')).toBe(false);
    expect(isSeniorByRegex('Software Engineer', 'We want 2–4 yrs of experience.')).toBe(false);
  });

  it('matches years of experience in the body, not just the title', () => {
    expect(isSeniorByRegex('Backend Engineer', 'You have 7 years of professional experience.')).toBe(true);
    expect(isSeniorByRegex('Backend Engineer', 'You have 10+ years shipping services.')).toBe(true);
  });

  it('does not fire on a seniority word inside another word', () => {
    expect(isSeniorByRegex('Leadership Development Designer', '')).toBe(false);
    expect(isSeniorByRegex('Usr Interface Engineer', '')).toBe(false);
  });

  it('lets "Member of Technical Staff" through — it is an IC title, and a voice-AI one', () => {
    expect(isSeniorByRegex('Member of Technical Staff', '')).toBe(false);
    expect(isSeniorByRegex('Senior Member of Technical Staff', '')).toBe(true);
  });

  it('catches the prose phrasings a title-only filter misses', () => {
    expect(isSeniorByRegex('Engineer', 'You will set the technical direction for the group.')).toBe(true);
    expect(isSeniorByRegex('Engineer', "You'll own the roadmap for our platform.")).toBe(true);
    expect(isSeniorByRegex('Engineer', 'Deep expertise is expected in distributed systems.')).toBe(true);
    expect(isSeniorByRegex('Engineer', 'You will mentor junior engineers on the team.')).toBe(true);
    expect(isSeniorByRegex('Engineer', 'You will manage a team of five engineers.')).toBe(true);
  });

  it('does not fire on ordinary junior prose', () => {
    expect(isSeniorByRegex('Software Engineer', 'You will own your projects and ship weekly.')).toBe(false);
    expect(isSeniorByRegex('Product Designer', 'You will make an impact on a growing team.')).toBe(false);
    expect(isSeniorByRegex('Engineer', 'You will work with senior engineers who will mentor you.')).toBe(false);
  });

  it('reads the bands below senior from the title and the years asked for', () => {
    expect(extract({ title: 'Software Engineering Intern', description: '' }).seniority).toBe('entry');
    expect(extract({ title: 'New Grad Software Engineer', description: '' }).seniority).toBe('entry');
    expect(extract({ title: 'Junior Product Designer', description: '' }).seniority).toBe('junior');
    expect(extract({ title: 'Associate UX Designer', description: '' }).seniority).toBe('junior');
    expect(extract({ title: 'Backend Engineer', description: 'You have 1-2 years of experience.' }).seniority).toBe('junior');
    expect(extract({ title: 'Backend Engineer', description: 'You have one to three years of experience.' }).seniority).toBe('junior');
    expect(extract({ title: 'Backend Engineer', description: 'You have 2-5 years of experience.' }).seniority).toBe('mid');
    expect(extract({ title: 'Backend Engineer', description: 'You have 3-4 years of experience.' }).seniority).toBe('mid');
    // Nothing stated at all lands on mid, the least flattering of the three visible bands.
    expect(extract({ title: 'Backend Engineer', description: 'You will write services.' }).seniority).toBe('mid');
  });
});

// ---------------------------------------------------------------------------------------
// Track
// ---------------------------------------------------------------------------------------

describe('track', () => {
  it('reads the title first', () => {
    expect(extract({ title: 'Product Designer', description: '' }).track).toBe('design');
    expect(extract({ title: 'Backend Engineer, Payments', description: '' }).track).toBe('engineering');
    expect(extract({ title: 'Member of Technical Staff', description: '' }).track).toBe('engineering');
  });

  it('vetoes a GTM or PM role that happens to contain a track word', () => {
    expect(extract({ title: 'Sales Engineer', description: '' }).track).toBe('other');
    expect(extract({ title: 'Design Program Manager', description: '' }).track).toBe('other');
    expect(extract({ title: 'Product Manager, Growth', description: '' }).track).toBe('other');
    expect(extract({ title: 'Technical Support Engineer', description: '' }).track).toBe('other');
    expect(extract({ title: 'Marketing Associate', description: '' }).track).toBe('other');
  });

  it('falls back to the department the ATS returned when the title says nothing', () => {
    expect(
      extract({ title: 'Member of Staff', description: '', sourceFields: { department: 'Design' } }).track,
    ).toBe('design');
    expect(
      extract({
        title: 'Analyst, Special Projects',
        description: '',
        sourceFields: { department: 'Sales', team: 'Enterprise' },
      }).track,
    ).toBe('other');
  });

  it('falls back to the body only with a clear margin', () => {
    const design =
      'You will run user research, build wireframes in Figma, own the design system, and lead design critique on prototyping work.';
    expect(extract({ title: 'Consultant', description: design }).track).toBe('design');
    // One stray mention of an API decides nothing.
    expect(extract({ title: 'Consultant', description: 'You will talk to customers about our API.' }).track).toBe('other');
  });
});

// ---------------------------------------------------------------------------------------
// Structured fields beat the prose
// ---------------------------------------------------------------------------------------

describe('precedence', () => {
  it('prefers the source field over anything the description says', () => {
    const description = 'This hybrid contract role is based in our Berlin office.';
    const result = extract({
      title: 'Software Engineer',
      description,
      sourceFields: { employmentType: 'full-time', workMode: 'remote', location: 'Austin, Texas' },
    });
    expect(result.employment_type).toBe('full-time');
    expect(result.work_mode).toBe('remote');
    expect(result.location).toBe('Austin, Texas');
  });

  it('falls back to the text when the source said nothing', () => {
    const result = extract({
      title: 'Software Engineer',
      description: 'This hybrid contract role runs for six months.',
    });
    expect(result.employment_type).toBe('contract');
    expect(result.work_mode).toBe('hybrid');
    expect(result.location).toBeNull();
  });

  it('takes responsibilities and skills from the sections the source structured', () => {
    const result = extract({
      title: 'Software Engineer',
      description: 'We build things.',
      sourceFields: {
        sections: [
          { heading: 'Responsibilities', items: ['Ship production services', 'Review pull requests'] },
          { heading: 'Requirements', items: ["Bachelor's degree in computer science", 'Fluent in Go'] },
        ],
      },
    });
    expect(result.responsibilities).toEqual(['Ship production services', 'Review pull requests']);
    expect(result.skills).toEqual(["Bachelor's degree in computer science", 'Fluent in Go']);
    expect(result.education).toEqual(["Bachelor's degree in computer science"]);
  });

  it('drops marketing copy from the bullets', () => {
    const result = extract({
      title: 'Software Engineer',
      description: '',
      sourceFields: {
        sections: [
          {
            heading: 'What you will do',
            items: ['Thrive in a fast-paced environment', 'Ship the payments API'],
          },
        ],
      },
    });
    expect(result.responsibilities).toEqual(['Ship the payments API']);
  });
});

// ---------------------------------------------------------------------------------------
// Sections, parsed where the markup still exists
// ---------------------------------------------------------------------------------------

describe('parseSections', () => {
  it('reads headings and bullets out of HTML', () => {
    expect(parseSections('<h3>Responsibilities</h3><ul><li>Ship code</li><li>Write tests</li></ul>')).toEqual([
      { heading: 'Responsibilities', items: ['Ship code', 'Write tests'] },
    ]);
  });

  it('reads Greenhouse double-escaped HTML', () => {
    const escaped = '&lt;h3&gt;Requirements&lt;/h3&gt;&lt;ul&gt;&lt;li&gt;Fluent in Python&lt;/li&gt;&lt;/ul&gt;';
    expect(parseSections(escaped)).toEqual([{ heading: 'Requirements', items: ['Fluent in Python'] }]);
  });

  it('reads Ashby markdown', () => {
    expect(parseSections('## Requirements\n\n- Fluent in Python\n- Ships weekly')).toEqual([
      { heading: 'Requirements', items: ['Fluent in Python', 'Ships weekly'] },
    ]);
  });

  it('returns nothing for a body with no list structure', () => {
    expect(parseSections('We are hiring an engineer to work on billing.')).toEqual([]);
    expect(parseSections(null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------
// Pay
// ---------------------------------------------------------------------------------------

describe('pay rate', () => {
  const pay = (description: string) => extract({ title: 'Engineer', description }).pay_rate;

  it('reads an annual range', () => {
    expect(pay('The salary range is $120,000 - $160,000 per year.')).toEqual({
      min: 120_000,
      max: 160_000,
      period: 'year',
    });
  });

  it('reads an hourly rate', () => {
    expect(pay('Interns are paid $55/hr.')).toEqual({ min: 55, max: null, period: 'hour' });
    expect(pay('This role pays $45 per hour.')).toEqual({ min: 45, max: null, period: 'hour' });
  });

  it('reads a k-suffixed range', () => {
    expect(pay('Compensation is $120k-$160k.')).toEqual({ min: 120_000, max: 160_000, period: 'year' });
  });

  it('infers the period from magnitude when the posting states none', () => {
    expect(pay('Base compensation of $185,000.')).toEqual({ min: 185_000, max: null, period: 'year' });
  });

  it('is not fooled by a 401(k) or a headcount', () => {
    expect(pay('We offer a 401k match and have 10k users.')).toBeNull();
  });

  it('reads paid / unpaid, and leaves unknown as null', () => {
    const paid = (description: string) => extract({ title: 'Engineer', description }).paid;
    expect(paid('This is a paid internship at $30/hour.')).toBe(true);
    expect(paid('This internship is unpaid.')).toBe(false);
    expect(paid('This internship is for course credit only.')).toBe(false);
    expect(paid('You will build our billing service.')).toBeNull();
    // "unpaid leave" is benefits boilerplate, not this role's pay.
    expect(paid('Benefits include unpaid leave for family reasons.')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Summary — extractive, never generated
// ---------------------------------------------------------------------------------------

describe('summary', () => {
  it('takes the first sentence after the role marker', () => {
    const body = normalizeDescription(
      'About Anthropic Anthropic builds AI systems. About the role You will build evaluation tooling for frontier models. You will also write tests.',
    );
    expect(extractSummary(body)).toBe('You will build evaluation tooling for frontier models.');
  });

  it('strips a leading company preamble when there is no role marker', () => {
    const body = normalizeDescription(
      'Who we are Northwind is a logistics company serving the midwest. We move freight.',
    );
    expect(extractSummary(body)).toBe('Northwind is a logistics company serving the midwest.');
  });

  it('skips a metadata line masquerading as a sentence', () => {
    const body = normalizeDescription(
      'Location: Onsite — Austin, TX. Employment Type: Direct Hire, Full-Time. We build autonomous drone perception systems for defense.',
    );
    expect(extractSummary(body)).toBe('We build autonomous drone perception systems for defense.');
  });

  it('is copied text, never generated', () => {
    const body = 'We are building a payments platform for small businesses. It is hard work.';
    expect(body).toContain(extractSummary(body)!);
  });

  it('returns null for an empty body', () => {
    expect(extractSummary('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------
// Season, graduation, badges
// ---------------------------------------------------------------------------------------

describe('the smaller fields', () => {
  it('reads an internship season', () => {
    expect(extract({ title: 'SWE Intern - Summer 2027', description: '' }).internship_season).toBe('summer');
    expect(extract({ title: 'Design Co-op', description: 'This is our fall internship cohort.' }).internship_season).toBe('fall');
    expect(extract({ title: 'Backend Engineer', description: 'We ship in the spring.' }).internship_season).toBeNull();
  });

  it('reads an expected graduation window', () => {
    expect(extract({ title: 'Intern', description: 'For students graduating in May 2027.' }).expected_grad).toBe('May 2027');
    expect(extract({ title: 'Intern', description: 'Class of 2028 preferred.' }).expected_grad).toBe('2028');
    expect(extract({ title: 'Intern', description: 'You will write Go.' }).expected_grad).toBeNull();
  });

  it('derives badges from the text, and inverts a sponsorship denial', () => {
    const badges = (description: string, title = 'Engineer') =>
      extract({ title, description }).badges;
    expect(badges('We offer visa sponsorship for this role.')).toContain('visa-sponsorship');
    expect(badges('We cannot provide visa sponsorship for this role.')).not.toContain('visa-sponsorship');
    expect(badges('Requires an active security clearance.')).toContain('security-clearance');
    expect(badges('Please submit a portfolio with your application.')).toContain('portfolio-required');
    expect(badges('This is a summer internship.', 'Design Intern')).toContain('internship');
  });
});

// ---------------------------------------------------------------------------------------
// The drop gate
// ---------------------------------------------------------------------------------------

describe('toStored', () => {
  it('drops a track other than design or engineering', () => {
    expect(toStored(extract({ title: 'Marketing Associate', description: '' }), '')).toBeNull();
  });

  it('drops senior+', () => {
    expect(toStored(extract({ title: 'Staff Engineer', description: '' }), '')).toBeNull();
  });

  it('drops the summary for design — the Design tab has no summary column', () => {
    const body = 'You will design our onboarding flow end to end for new customers.';
    expect(toStored(extract({ title: 'Product Designer', description: body }), body)!.summary).toBeNull();
    expect(toStored(extract({ title: 'Software Engineer', description: body }), body)!.summary).not.toBeNull();
  });

  it('badges exactly the voice-AI roles, all of them engineering', () => {
    for (const fixture of POSTING_FIXTURES) {
      const body = normalizeDescription(fixture.description);
      const stored = toStored(extract({ title: fixture.title, description: body }), body);
      if (!stored) continue;
      const badged = stored.badges.includes(VOICE_BADGE);
      if (badged) expect(stored.track, fixture.title).toBe('engineering');
      // A design posting never carries the badge, whatever its body says.
      if (stored.track === 'design') expect(badged, fixture.title).toBe(false);
    }
  });

  it('discards badges outside the allowed vocabulary', () => {
    const extraction = extract({ title: 'Software Engineer', description: 'We ship code.' });
    const stored = toStored({ ...extraction, badges: ['internship', 'not-a-badge'] }, '');
    expect(stored!.badges).toEqual(['internship']);
  });
});

// ---------------------------------------------------------------------------------------
// The hand-labeled set, graded field by field
// ---------------------------------------------------------------------------------------

describe('the hand-labeled fixture set', () => {
  it.each(POSTING_FIXTURES.map((fixture) => [fixture.title, fixture] as const))(
    'extracts %s as labeled',
    (_title, fixture) => {
      const actual = run(fixture);
      for (const field of GRADED_FIELDS) {
        expect(actual[field], `${fixture.title} · ${field}`).toEqual(fixture.expected[field]);
      }
    },
  );
});
