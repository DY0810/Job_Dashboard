import { z } from 'zod';
import { ScreeningFactsSchema, ScreeningRequirementsSchema } from '../lib/applications/application-context-protocol.ts';
import type { ApplicationContext } from '../lib/applications/application-context-protocol.ts';
import type { QuestionDispatch } from './question-client.ts';
import { formQuestionKey, type AtsField } from './ats/protocol.ts';
export { ScreeningFactsSchema, ScreeningRequirementsSchema };
export type ScreeningFacts = z.infer<typeof ScreeningFactsSchema>;
export type ScreeningRequirements = z.infer<typeof ScreeningRequirementsSchema>;
export type ScreeningDecision =
  | { status: 'eligible'; evidence: string[] }
  | { status: 'needs_question'; evidence: string[]; reasons: string[] }
  | { status: 'blocked'; evidence: string[]; reasons: string[] };

const includes = (values: string[], expected: string) => values.some((value) => value.toLowerCase() === expected.toLowerCase());
const overlaps = (values: string[], expected: string[]) => expected.some((value) => values.some((candidate) => candidate.toLowerCase().includes(value.toLowerCase()) || value.toLowerCase().includes(candidate.toLowerCase())));

export function screenApplication(factsInput: unknown, requirementsInput: unknown): ScreeningDecision {
  const facts = ScreeningFactsSchema.parse(factsInput), requirements = ScreeningRequirementsSchema.parse(requirementsInput);
  const blocked: string[] = [], questions: string[] = [], evidence = [...requirements.excerpts];
  if (requirements.countries.length) {
    if (facts.countries.state !== 'confirmed') questions.push('country_unknown');
    else if (!requirements.countries.some((country) => includes(facts.countries.values, country))) blocked.push('country_ineligible');
  }
  if (requirements.degreeLevels.length) {
    if (facts.degreeLevels.state !== 'confirmed') questions.push('degree_unknown');
    else if (!overlaps(facts.degreeLevels.values, requirements.degreeLevels)) blocked.push('degree_ineligible');
  }
  if (requirements.majors.length) {
    if (facts.majors.state !== 'confirmed') questions.push('major_unknown');
    else if (!overlaps(facts.majors.values, requirements.majors)) blocked.push('major_ineligible');
  }
  if (requirements.terms.length) {
    if (facts.availableTerms.state !== 'confirmed') questions.push('term_unknown');
    else if (!overlaps(facts.availableTerms.values, requirements.terms)) blocked.push('term_ineligible');
  }
  if (requirements.graduationWindow) {
    if (facts.expectedGraduation.state !== 'confirmed' || !facts.expectedGraduation.month) questions.push('graduation_unknown');
    else if (facts.expectedGraduation.month < requirements.graduationWindow.earliest ||
        facts.expectedGraduation.month > requirements.graduationWindow.latest) blocked.push('graduation_ineligible');
  }
  if (requirements.authorizationRequired) {
    if (facts.workAuthorization.state !== 'confirmed') questions.push('work_authorization_unknown');
    else if (!includes(facts.workAuthorization.values, 'authorized')) blocked.push('work_authorization_ineligible');
  }
  if (facts.pay.state === 'confirmed' && facts.pay.amount !== null) {
    if (requirements.paid === false) blocked.push('unpaid_below_preference');
    else if (requirements.paid === null) questions.push('employer_pay_unknown');
    else if (requirements.payFloor) {
      if (facts.pay.currency !== requirements.payFloor.currency || facts.pay.period !== requirements.payFloor.period) questions.push('pay_currency_unverified');
      else if (requirements.payFloor.amount < facts.pay.amount) questions.push('employer_pay_range_unknown');
    }
  }
  if (blocked.length) return { status: 'blocked', evidence, reasons: [...new Set(blocked)].sort() };
  if (questions.length) return { status: 'needs_question', evidence, reasons: [...new Set(questions)].sort() };
  return { status: 'eligible', evidence };
}

const screeningPrompts: Record<string, string> = {
  country_unknown: 'Which two-letter country code applies to your job eligibility for this role?',
  degree_unknown: 'What degree level are you pursuing or have you completed?',
  major_unknown: 'What is your academic major for this application?',
  term_unknown: 'Which internship term are you available for?',
  graduation_unknown: 'What is your expected graduation month? Enter YYYY-MM.',
  work_authorization_unknown: 'Are you legally authorized to work in the country required for this role? Enter authorized or not_authorized.',
  employer_pay_unknown: 'The posting does not state pay. Enter accept only if you agree to consider this role despite your pay preference.',
  employer_pay_range_unknown: 'The published minimum is below your pay preference. Enter accept only if you agree to consider this role.',
  pay_currency_unverified: 'The pay currency or period differs from your preference. Enter accept only if you agree to consider this role.',
};

export function screeningQuestions(context: ApplicationContext, reasons: string[]): QuestionDispatch {
  return {
    kind: 'questions', expectedProfileRevision: context.profileRevision, company: context.company, role: context.role,
    questions: reasons.map(reason => {
      const key = `screening-${reason.replace(/_unknown$/, '').replace(/^work_authorization$/, 'authorization')
        .replace(/^graduation$/, 'graduation').replace(/^employer_pay_range$/, 'employer-pay')
        .replace(/^employer_pay$/, 'employer-pay').replace(/^pay_currency_unverified$/, 'employer-pay')
        .replaceAll('_', '-')}`;
      return {
        key, kind: 'needs_answer' as const, originalWording: screeningPrompts[reason] ?? `Review this eligibility question: ${reason}`,
        reason: `Workie could not verify this requirement from confirmed facts. Official posting: ${context.requirements.sourceUrl}`,
        required: true, meaning: { id: reason, reviewId: null }, schemaVersion: 1,
        scope: { kind: 'application' as const, country: null, employer: null, applicationId: context.applicationId,
          includesSubsidiaries: false, timeframe: 'current' as const, validFrom: null, validUntil: null,
          ats: context.identity.ats, tenant: context.identity.tenant, version: 1 },
        provenance: { source: 'system' as const, sourceId: null, sourceVersion: null,
          excerpt: context.requirements.excerpts.find(excerpt => excerpt.toLowerCase().includes(reason.includes('graduation') ? 'graduat' : reason.includes('pay') ? 'pay' : 'require'))?.slice(0, 1000) ?? null },
        field: { type: 'text' as const, allowBlank: false, declineValue: null, units: null, precision: null,
          minLength: 1, maxLength: 160, format: 'plain' as const }, factIds: [],
        sensitive: reason === 'work_authorization_unknown',
      };
    }),
  };
}

// Options come from the form (a fixed dropdown, select or radio group); without them the answer is free text.
function formField(field: AtsField, options = field.options) {
  const choices = [...new Set(options ?? [])].filter(option => option.length <= 300);
  return choices.length && choices.length <= 100
    ? { type: 'select' as const, allowBlank: false, declineValue: null, units: null, precision: null,
      options: choices.map(option => ({ value: option, label: option })), minSelections: 1, maxSelections: 1 }
    : { type: 'text' as const, allowBlank: false, declineValue: null, units: null, precision: null,
      minLength: 1, maxLength: 4000, format: 'plain' as const };
}

export function formQuestions(context: ApplicationContext, fields: AtsField[], options?: string[]): QuestionDispatch {
  return {
    kind: 'questions', expectedProfileRevision: context.profileRevision, company: context.company, role: context.role,
    questions: fields.slice(0, 20).map(field => ({
      key: formQuestionKey(field), kind: 'needs_answer' as const, originalWording: field.label,
      reason: `Required field on the official application: ${context.applicationUrl}`,
      required: true, meaning: { id: formQuestionKey(field), reviewId: null }, schemaVersion: 1,
      scope: { kind: 'application' as const, country: null, employer: null, applicationId: context.applicationId,
        includesSubsidiaries: false, timeframe: 'current' as const, validFrom: null, validUntil: null,
        ats: context.identity.ats, tenant: context.identity.tenant, version: 1 },
      provenance: { source: 'system' as const, sourceId: null, sourceVersion: null, excerpt: field.label },
      field: formField(field, options ?? field.options), factIds: [], sensitive: true,
    })),
  };
}
