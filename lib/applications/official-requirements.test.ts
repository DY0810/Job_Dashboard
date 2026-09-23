import { describe, expect, it } from 'vitest';
import { parseOfficialRequirements } from './official-requirements.ts';

const base = {
  sourceUrl: 'https://job-boards.greenhouse.io/acme/jobs/123', company: 'Acme', title: 'Software Engineer Intern',
  country: 'US', location: 'Remote, United States', sourceFields: null, paid: null,
};

describe('parseOfficialRequirements', () => {
  it('extracts only explicit official requirements and preserves the exact body', () => {
    const description = `Join us for a Summer 2027 internship. Candidates must be authorized to work in the US without sponsorship.\n\nRequirements\n- Pursuing a bachelor's degree in computer science.\n- Paid at USD 45/hour.`;
    expect(parseOfficialRequirements({ ...base, description })).toMatchObject({
      officialDescription: description, countries: ['US'], degreeLevels: ['bachelor'], majors: ['computer science'],
      terms: ['summer 2027'], authorizationRequired: true, paid: true,
      payFloor: { currency: 'USD', amount: 45, period: 'hour' },
    });
  });

  it('does not invent degree, major, term, authorization, or pay-floor facts', () => {
    expect(parseOfficialRequirements({ ...base, description: 'You will work with a small product team.' })).toMatchObject({
      degreeLevels: [], majors: [], terms: [], authorizationRequired: false, paid: null, payFloor: null,
    });
  });

  it('recognizes an explicit unpaid condition over a generic internship title', () => {
    expect(parseOfficialRequirements({ ...base, description: 'Fall internship for course credit only. This is unpaid.' })).toMatchObject({
      terms: ['fall'], paid: false,
    });
  });

  it('keeps a graduation window separate from the internship term', () => {
    expect(parseOfficialRequirements({ ...base, description: 'Summer 2028 internship. Candidates graduating between Winter 2027 and Summer 2028 are eligible.' })).toMatchObject({
      terms: ['summer 2028'], graduationWindow: { earliest: '2026-12', latest: '2028-08' },
    });
    expect(parseOfficialRequirements({ ...base, description: 'Graduating in December 2028.' })).toMatchObject({
      terms: [], graduationWindow: { earliest: '2028-12', latest: '2028-12' },
    });
    expect(parseOfficialRequirements({ ...base, description: 'Summer 2028 internship for students graduating between Winter 2027 and Summer 2028.' })).toMatchObject({
      terms: ['summer 2028'], graduationWindow: { earliest: '2026-12', latest: '2028-08' },
    });
    expect(parseOfficialRequirements({ ...base, description: 'Summer 2027 internship. Applicants graduating in Fall 2027 or later are eligible.' })).toMatchObject({
      terms: ['summer 2027'], graduationWindow: { earliest: '2027-09', latest: '2099-12' },
    });
  });
});
