import { describe, expect, it } from 'vitest';
import { answerFor } from './answer-inbox.mjs';

const question = (wording: string, field: object, tenant = 'acme', role = 'Intern (Summer 2027)') =>
  ({ descriptor: { originalWording: wording, field }, application: { tenant, role } });
const text = { type: 'text' };
const select = (...values: string[]) => ({ type: 'select', options: values.map(value => ({ value, label: value })) });

describe('answerFor', () => {
  it('gives a dropdown the first preference it offers, including a pattern, and text the first plain answer', () => {
    const rules = [{ match: 'which (college|university)', answer: ['State University', 'Other'] },
      { match: 'veteran', answer: '/^I am not a protected veteran/' }];
    expect(answerFor(question('Which college do you attend?', select('Tech', 'Other')), rules)).toBe('Other');
    expect(answerFor(question('Which college do you attend?', text), rules)).toBe('State University');
    expect(answerFor(question('Veteran Status', select('I am not a protected veteran', 'I identify as one')), rules)).toBe('I am not a protected veteran');
    expect(answerFor(question('Veteran Status', text), rules)).toBeUndefined(); // only a pattern: nothing to type
  });

  it('respects employer and role limits and leaves anything unmatched or not on offer for the applicant', () => {
    const rules = [{ match: 'excite', tenant: 'acme', role: 'security', answer: 'Security essay' },
      { match: 'sponsorship', answer: 'No' }, { match: 'sponsorship', answer: 'Maybe' }];
    expect(answerFor(question('What excites you?', text, 'acme', 'Product Security Intern'), rules)).toBe('Security essay');
    expect(answerFor(question('What excites you?', text, 'acme', 'Device Intern'), rules)).toBeUndefined();
    expect(answerFor(question('What excites you?', text, 'other', 'Product Security Intern'), rules)).toBeUndefined();
    expect(answerFor(question('Will you require sponsorship?', select('Yes')), rules)).toBeUndefined(); // no fallthrough to a later rule
    expect(answerFor(question('Why us?', text), rules)).toBeUndefined();
  });
});
