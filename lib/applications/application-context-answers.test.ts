import { describe, expect, it, vi } from 'vitest';
import { createEmptyProfile, DisclosureSchema, ProfileSchema, ProfileSections } from './profile.ts';
import { applicationAnswers } from './application-context.ts';
import { greenhouseAnswer } from '../../worker/ats/greenhouse.ts';

vi.mock('server-only', () => ({}));

const confirmed = <T extends { state: string; value: unknown; confirmedAt: string | null }>(fact: T, value: unknown): T =>
  ({ ...fact, state: 'confirmed', value, confirmedAt: new Date().toISOString() });

describe('exact employer disclosure answers', () => {
  it('uses a confirmed Figma answer only for the matching employer and exact question', () => {
    const profile = createEmptyProfile();
    const disclosure = DisclosureSchema.parse({});
    const wording = 'Have you ever worked for Figma before, as an employee or a contractor/consultant?';
    disclosure.employer = confirmed(disclosure.employer, 'Figma');
    disclosure.includesSubsidiaries = confirmed(disclosure.includesSubsidiaries, false);
    disclosure.meaning = confirmed(disclosure.meaning, 'prior_employment');
    disclosure.exactQuestion = confirmed(disclosure.exactQuestion, wording);
    disclosure.timeframe = confirmed(disclosure.timeframe, 'ever');
    disclosure.answer = { ...confirmed(disclosure.answer, false), scope: {
      ...disclosure.answer.scope, kind: 'employer', employer: 'Figma', timeframe: 'ever',
    } };
    profile.disclosures.answers = [disclosure];
    expect(ProfileSchema.safeParse(profile).success).toBe(true);
    const field = { key: 'question_19438738004', label: wording, kind: 'combobox' as const, required: true };
    const input = (company: string) => ({
      identity: { ats: 'greenhouse' as const, tenant: 'figma', requisition: '6143238004' },
      company, role: 'Software Engineer Intern', applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/6143238004',
      answers: applicationAnswers(profile, [], company), documents: {},
    });
    expect(greenhouseAnswer(input('Figma'), field)).toBe('No');
    expect(greenhouseAnswer(input('Other employer'), field)).toBeUndefined();
    expect(greenhouseAnswer(input('Figma'), { ...field, label: `${wording} Includes subsidiaries?` })).toBeUndefined();
    disclosure.answer = { ...disclosure.answer, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer(input('Figma'), field)).toBeUndefined();
  });
});

describe('confirmed contact location', () => {
  it('uses city and phone country only for their matching Greenhouse contact fields', () => {
    const profile = createEmptyProfile();
    profile.identity.currentLocation = confirmed(profile.identity.currentLocation, 'Los Angeles, California, United States');
    profile.identity.phones = ProfileSections.identity.parse({ phones: [{}] }).phones;
    profile.identity.phones[0].number = confirmed(profile.identity.phones[0].number, '555 555 0100');
    profile.identity.phones[0].country = confirmed(profile.identity.phones[0].country, 'US');
    expect(ProfileSchema.safeParse(profile).success).toBe(true);
    const answers = applicationAnswers(profile, [], 'Figma');
    const input = { identity: { ats: 'greenhouse' as const, tenant: 'figma', requisition: '6143238004' },
      company: 'Figma', role: 'Software Engineer Intern', applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/6143238004',
      answers, documents: {} };
    const city = { key: 'candidate-location', label: 'Location (City)', kind: 'combobox' as const, required: true };
    const country = { key: 'country', label: 'Country', kind: 'combobox' as const, required: true };
    expect(greenhouseAnswer(input, city)).toBe('Los Angeles, California, United States');
    expect(greenhouseAnswer(input, country)).toBe('United States +1');
    expect(greenhouseAnswer(input, { ...city, label: 'Willing to relocate?' })).toBeUndefined();
    profile.identity.currentLocation = { ...profile.identity.currentLocation, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, city)).toBeUndefined();
    profile.identity.phones[0].country = { ...profile.identity.phones[0].country, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, country)).toBeUndefined();
  });
});

describe('Figma voluntary choices', () => {
  it('uses only matching confirmed facts and official options', () => {
    const profile = createEmptyProfile();
    profile.voluntary.pronouns = confirmed(profile.voluntary.pronouns, 'he/him/his');
    profile.voluntary.gender = confirmed(profile.voluntary.gender, 'Man');
    profile.voluntary.raceEthnicity = confirmed(profile.voluntary.raceEthnicity, ['Asian', 'Not Hispanic or Latino']);
    profile.voluntary.veteran = confirmed(profile.voluntary.veteran, 'Never a veteran');
    const input = { identity: { ats: 'greenhouse' as const, tenant: 'figma', requisition: '6143238004' },
      company: 'Figma', role: 'Software Engineer Intern', applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/6143238004',
      answers: applicationAnswers(profile, [], 'Figma'), documents: {} };
    const field = (key: string, label: string) => ({ key, label, kind: 'combobox' as const, required: false });
    expect(greenhouseAnswer(input, field('question_19438728004', 'Pronouns'))).toBe('he/him/his');
    expect(greenhouseAnswer(input, field('gender', 'Gender'))).toBe('Male');
    expect(greenhouseAnswer(input, field('hispanic_ethnicity', 'Are you Hispanic/Latino?'))).toBe('No');
    expect(greenhouseAnswer(input, field('veteran_status', 'Veteran Status'))).toBe('I am not a protected veteran');
    expect(greenhouseAnswer({ ...input, identity: { ...input.identity, requisition: 'other' } }, field('gender', 'Gender'))).toBeUndefined();
    profile.voluntary.veteran = { ...profile.voluntary.veteran, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, field('veteran_status', 'Veteran Status'))).toBeUndefined();
  });
});
