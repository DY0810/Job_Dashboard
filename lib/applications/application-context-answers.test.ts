import { describe, expect, it, vi } from 'vitest';
import { createEmptyProfile, DisclosureSchema, ProfileSchema } from './profile.ts';
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
