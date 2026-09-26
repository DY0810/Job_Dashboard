import { describe, expect, it, vi } from 'vitest';
import { createEmptyProfile, DisclosureSchema, ProfileSchema, ProfileSections } from './profile.ts';
import { applicationAnswers } from './application-context.ts';
import { greenhouseAnswer } from '../../worker/ats/greenhouse.ts';
import { formQuestionKey } from '../../worker/ats/protocol.ts';

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
    // Every hosted form puts the same phone-country picker beside Phone.
    expect(greenhouseAnswer({ ...input, identity: { ...input.identity, tenant: 'other' } }, country)).toBe('United States +1');
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
    // Greenhouse's standard self-identification fields fill on every hosted form; Figma's own pronoun question does not.
    const other = { ...input, identity: { ...input.identity, tenant: 'hpiq', requisition: '6116398004' } };
    expect(greenhouseAnswer(other, field('gender', 'Gender'))).toBe('Male');
    expect(greenhouseAnswer(other, field('question_19438728004', 'Pronouns'))).toBeUndefined();
    profile.voluntary.veteran = { ...profile.voluntary.veteran, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, field('veteran_status', 'Veteran Status'))).toBeUndefined();
  });
});

describe('Greenhouse education dropdowns', () => {
  it('names the degree the way the dropdown does, and leaves an inbox answer in charge', () => {
    const field = { key: 'degree--0', label: 'Degree', kind: 'combobox' as const, required: true };
    const input = (answers: Record<string, string>) => ({ identity: { ats: 'greenhouse' as const, tenant: 'hpiq', requisition: '6116398004' },
      company: 'HP IQ', role: 'Intern', applicationUrl: 'https://job-boards.greenhouse.io/hpiq/jobs/6116398004', answers, documents: {} });
    expect(greenhouseAnswer(input({ 'degree--0': 'bachelor' }), field)).toBe("Bachelor's Degree");
    expect(greenhouseAnswer(input({ 'degree--0': 'doctorate' }), field)).toBe('doctorate'); // Ph.D., M.D. or J.D.: asked, not guessed
    expect(greenhouseAnswer(input({ 'degree--0': 'bachelor', [formQuestionKey(field)]: 'Other' }), field)).toBe('Other');
  });
});

describe('Figma education and links', () => {
  it('uses confirmed enrollment, month, and profile links only on the matching form', () => {
    const profile = createEmptyProfile();
    profile.identity.linkedin = confirmed(profile.identity.linkedin, 'https://linkedin.com/in/example');
    profile.identity.portfolio = confirmed(profile.identity.portfolio, 'https://example.com');
    const school = ProfileSections.education.parse({ schools: [{}] }).schools[0];
    school.school = confirmed(school.school, 'University of Southern California');
    school.status = confirmed(school.status, 'in_progress');
    school.expectedGraduation = confirmed(school.expectedGraduation, { precision: 'month', value: '2028-12' });
    profile.education.schools = [school];
    const input = { identity: { ats: 'greenhouse' as const, tenant: 'figma', requisition: '6143238004' },
      company: 'Figma', role: 'Software Engineer Intern', applicationUrl: 'https://job-boards.greenhouse.io/figma/jobs/6143238004',
      answers: applicationAnswers(profile, [], 'Figma'), documents: {} };
    const field = (key: string, label: string) => ({ key, label, kind: 'combobox' as const, required: true });
    const grad = field('question_19438730004', 'If you are currently enrolled in university or a program, what is your expected graduation date?');
    expect(greenhouseAnswer(input, grad)).toBe('Fall 2028');
    expect(greenhouseAnswer(input, field('end-month--0', 'End date month'))).toBe('December');
    expect(greenhouseAnswer(input, field('question_19438735004', 'LinkedIn Profile'))).toBe('https://linkedin.com/in/example');
    expect(greenhouseAnswer(input, field('question_19438736004', 'Other Website'))).toBe('https://example.com');
    expect(greenhouseAnswer({ ...input, identity: { ...input.identity, requisition: 'other' } }, grad)).toBeUndefined();
    school.status = { ...school.status, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, grad)).toBeUndefined();
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, field('end-month--0', 'End date month'))).toBeUndefined();
    school.status = confirmed(school.status, 'in_progress');
    school.expectedGraduation = { ...school.expectedGraduation, state: 'candidate', confirmedAt: null };
    expect(greenhouseAnswer({ ...input, answers: applicationAnswers(profile, [], 'Figma') }, grad)).toBeUndefined();
  });
});

describe('common Greenhouse wording', () => {
  it('answers links, work authorization and sponsorship from confirmed facts for any employer', () => {
    const profile = createEmptyProfile();
    profile.identity.linkedin = confirmed(profile.identity.linkedin, 'https://linkedin.com/in/example');
    profile.identity.github = confirmed(profile.identity.github, 'https://github.com/example');
    const us = ProfileSections.authorization.parse({ countries: [{}] }).countries[0];
    us.country = confirmed(us.country, 'US');
    const inUs = <T extends typeof us.rightToWork>(fact: T, value: boolean) => ({ ...confirmed(fact, value), scope: { ...fact.scope, kind: 'country' as const, country: 'US' } });
    us.rightToWork = inUs(us.rightToWork, true);
    us.sponsorshipNow = inUs(us.sponsorshipNow, false);
    profile.authorization.countries = [us];
    expect(ProfileSchema.safeParse(profile).success).toBe(true);
    const ask = (label: string, postingCountry: string | null = 'US', kind: 'text' | 'combobox' = 'combobox') => greenhouseAnswer({
      identity: { ats: 'greenhouse' as const, tenant: 'sage49', requisition: '6131185004' }, company: 'Sage', role: 'Full Stack Intern',
      applicationUrl: 'https://job-boards.greenhouse.io/sage49/jobs/6131185004',
      answers: applicationAnswers(profile, ['authorized'], 'Sage', postingCountry), documents: {},
    }, { key: 'question_1', label, kind, required: true });
    const future = 'Will you now or in the future require sponsorship for employment visa status (e.g., H-1B visa)?';
    expect(ask('LinkedIn Profile', 'US', 'text')).toBe('https://linkedin.com/in/example');
    expect(ask('GitHub URL', 'US', 'text')).toBe('https://github.com/example');
    expect(ask('Are you legally authorized to work in the country for which you are applying?')).toBe('Yes');
    expect(ask('Are you authorized to work in the US?', null)).toBe('Yes');
    expect(ask('Do you require sponsorship for employment visa status?')).toBe('No');
    expect(ask(future)).toBeUndefined(); // future sponsorship is not confirmed yet
    us.sponsorshipFuture = inUs(us.sponsorshipFuture, false);
    expect(ask(future)).toBe('No');
    // Ambiguous or unsupported wording still reaches the inbox.
    expect(ask('How did you hear about us? (LinkedIn, Handshake, other)', 'US', 'text')).toBeUndefined();
    expect(ask('Are you legally authorized to work in the United States without sponsorship?')).toBeUndefined();
    expect(ask('Are you not authorized to work in the US?')).toBeUndefined();
    expect(ask('Are you authorized to work in the country you live in?')).toBeUndefined();
    expect(ask('Are you legally authorized to work in the country for which you are applying?', 'KR')).toBeUndefined();
    expect(ask('Can you work with us onsite?')).toBeUndefined();
  });
});
