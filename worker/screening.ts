import { z } from 'zod';
import { ScreeningFactsSchema, ScreeningRequirementsSchema } from '../lib/applications/application-context-protocol.ts';
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
  if (requirements.authorizationRequired) {
    if (facts.workAuthorization.state !== 'confirmed') questions.push('work_authorization_unknown');
    else if (!includes(facts.workAuthorization.values, 'authorized')) blocked.push('work_authorization_ineligible');
  }
  if (requirements.paid === true && facts.pay.state !== 'confirmed') questions.push('pay_unknown');
  if (requirements.paid === false && facts.pay.state === 'confirmed' && facts.pay.amount !== null) blocked.push('paid_requirement_mismatch');
  if (requirements.payFloor) {
    if (facts.pay.state !== 'confirmed' || facts.pay.amount === null || facts.pay.currency === null || facts.pay.period === null) questions.push('pay_floor_unknown');
    else if (facts.pay.currency !== requirements.payFloor.currency || facts.pay.period !== requirements.payFloor.period) questions.push('pay_currency_unverified');
    else if (facts.pay.amount < requirements.payFloor.amount) blocked.push('pay_below_floor');
  }
  if (blocked.length) return { status: 'blocked', evidence, reasons: [...new Set(blocked)].sort() };
  if (questions.length) return { status: 'needs_question', evidence, reasons: [...new Set(questions)].sort() };
  return { status: 'eligible', evidence };
}
