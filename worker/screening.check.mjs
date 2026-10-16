import assert from 'node:assert/strict';
import { test } from 'node:test';
import { screenApplication, screeningQuestions, formQuestions } from './screening.ts';
import { QuestionDispatchSchema } from './question-client.ts';
import { AtsAnswerErrors, AtsError, fillEach, formQuestionKey } from './ats/protocol.ts';

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

test('unknown employer fields become scoped inbox questions with exact wording', () => {
  const applicationId = crypto.randomUUID();
  const context = { applicationId, profileRevision: 2, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '123' },
    applicationUrl: 'https://job-boards.greenhouse.io/fixture/jobs/123' };
  const batch = QuestionDispatchSchema.parse(formQuestions(context, [
    { key: 'question_123', label: 'Are you a U.S. citizen?', kind: 'combobox', required: true },
  ]));
  assert.equal(batch.questions[0].key, formQuestionKey({ key: 'question_123', label: 'Are you a U.S. citizen?' }));
  assert.equal(batch.questions[0].originalWording, 'Are you a U.S. citizen?');
  assert.equal(batch.questions[0].scope.applicationId, applicationId);
  assert.equal(batch.questions[0].sensitive, true);
});

test('a fill keeps going past rejected answers so the whole form is asked at once', async () => {
  const filled = [];
  const error = await fillEach(['a', 'b', 'c', 'd'], async (key) => {
    if (key === 'a') throw new AtsError('REQUIRED_ANSWER_MISSING', key);
    if (key === 'c') throw new AtsError('ANSWER_OPTION_INVALID', key, ['Yes', 'No']);
    filled.push(key);
  }).catch(caught => caught);
  assert.ok(error instanceof AtsAnswerErrors);
  assert.deepEqual(error.errors.map(item => [item.message, item.options]), [['a', undefined], ['c', ['Yes', 'No']]]);
  assert.deepEqual(filled, ['b', 'd']);
  // Anything else still stops the fill at once.
  await assert.rejects(fillEach(['a', 'b'], async () => { throw new AtsError('FIELD_NOT_FOUND', 'a'); }), { code: 'FIELD_NOT_FOUND' });
  const many = Array.from({ length: 30 }, (_, index) => ({ key: `question_${index}`, label: `Question ${index}?`, kind: 'text', required: true }));
  assert.equal(formQuestions({ applicationId: crypto.randomUUID(), profileRevision: 1, company: 'Fixture', role: 'Intern',
    identity: { ats: 'greenhouse', tenant: 'fixture', requisition: '1' }, applicationUrl: 'https://job-boards.greenhouse.io/fixture/jobs/1' },
  many).questions.length, 30);
});
