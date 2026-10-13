import { describe, expect, it } from 'vitest';
import { statusBadge } from './badges.ts';
import { SUBMIT_APPROVAL } from './state.ts';

describe('statusBadge', () => {
  it.each([
    ['queued', null, 'queued', 'queued'],
    ['filling', null, 'progress', 'in progress'],
    ['submitting', null, 'progress', 'in progress'],
    ['needs_policy_decision', SUBMIT_APPROVAL, 'approval', 'needs approval'],
    ['needs_policy_decision', 'salary_floor', 'answer', 'needs answer'],
    ['retryable_failure', null, 'retry', 'retry'],
    ['provider_unavailable', null, 'retry', 'retry'],
    ['blocked_unsupported', null, 'unsupported', 'unsupported'],
    ['submission_unknown', null, 'unknown', 'unknown'],
    ['submitted', null, 'applied', 'applied'],
  ] as const)('%s (%s) -> %s', (state, reason, tone, label) => {
    expect(statusBadge(state, reason)).toEqual({ tone, label });
  });
});
