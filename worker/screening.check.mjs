import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenApplication, screeningQuestions } from './screening.ts';

const facts = {
  countries: { state: 'confirmed', values: ['US'] }, degreeLevels: { state: 'confirmed', values: ['bachelor'] },
  majors: { state: 'confirmed', values: ['computer science'] }, availableTerms: { state: 'confirmed', values: ['summer 2028'] },
  expectedGraduation: { state: 'confirmed', month: '2028-12' }, workAuthorization: { state: 'unknown', values: [] },
  pay: { state: 'unknown', amount: null, currency: null, period: null },
};
const requirements = {
  sourceUrl: 'https://boards.greenhouse.io/fixture/jobs/123', officialDescription: 'Summer 2028 internship',
  excerpts: ['Summer 2028 internship'], countries: [], degreeLevels: [], majors: [], terms: ['summer 2028'],
  graduationWindow: { earliest: '2028-09', latest: '2029-08' }, authorizationRequired: false,
  paid: true, payFloor: { amount: 20, currency: 'USD', period: 'hour' },
};

test('graduation and pay screening use their own confirmed facts', () => {
  assert.equal(screenApplication(facts, requirements).status, 'eligible');
  assert.deepEqual(screenApplication(facts, { ...requirements, graduationWindow: { earliest: '2027-01', latest: '2028-08' } }).reasons, ['graduation_ineligible']);
  assert.deepEqual(screenApplication({ ...facts, expectedGraduation: { state: 'unknown', month: null } }, requirements).reasons, ['graduation_unknown']);
  assert.equal(screenApplication({ ...facts, pay: { state: 'confirmed', amount: 25, currency: 'USD', period: 'hour' } }, requirements).status, 'needs_question');
  assert.deepEqual(screenApplication({ ...facts, pay: { state: 'confirmed', amount: 25, currency: 'USD', period: 'hour' } }, { ...requirements, paid: false }).reasons, ['unpaid_below_preference']);
});

test('missing screening facts produce application-scoped durable question descriptors', () => {
  const applicationId = crypto.randomUUID();
  const result = screeningQuestions({ applicationId, profileRevision: 2, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' }, requirements },
    ['graduation_unknown', 'work_authorization_unknown']);
  assert.equal(result.expectedProfileRevision, 2);
  assert.deepEqual(result.questions.map(q => q.key), ['screening-graduation', 'screening-authorization']);
  assert(result.questions.every(q => q.scope.applicationId === applicationId && q.required));
});
