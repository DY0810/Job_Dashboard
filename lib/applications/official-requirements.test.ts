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
});
