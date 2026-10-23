import { describe, expect, it } from 'vitest';
import { discoveryProblem, heldForDecision, queuedDetail, statusBadge } from './badges.ts';
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

describe('discovery on the Applications page', () => {
  const caps = { perEmployerCap: 1, dailyApplicationCap: 10 };
  const fine = { state: 'ready', errorCode: null, heldQuestions: {} } as const;

  it('says why a queued row will not start instead of promising its turn', () => {
    expect(queuedDetail({ state: 'running' }, fine, caps)).toBe('Waiting its turn. It starts on its own, up to 1 per employer and 10 a day.');
    expect(queuedDetail({ state: 'paused' }, undefined, caps)).toMatch(/^Its run is paused, so it will not start\./);
    expect(queuedDetail({ state: 'running' }, { ...fine, errorCode: 'POLICY_STALE' }, caps)).toMatch(/^It will not start: your Auto Apply policy changed/);
  });

  it('names a run that finds nothing, and the roles held for a decision with their reasons', () => {
    expect(discoveryProblem(fine)).toBeNull();
    expect(discoveryProblem({ ...fine, errorCode: 'POLICY_STALE' })).toMatch(/Stop it under Runs in Settings/);
    expect(discoveryProblem({ ...fine, state: 'failed', errorCode: 'CAPTURE_FAILED' })).toMatch(/could not finish looking for new roles \(capture failed\)/);
    expect(heldForDecision(fine)).toBeNull();
    expect(heldForDecision({ ...fine, heldQuestions: { pay_undisclosed: 12, pay_currency_or_period_unverified: 3 } }))
      .toBe('Not started under your current policy: pay not listed (12), pay in another currency or period than your floor (3). ' +
        'To include roles like these, change the policy.');
  });
});
