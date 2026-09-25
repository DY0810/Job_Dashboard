export const APPLICATION_STATES = [
  'queued', 'screening', 'tailoring', 'filling', 'ready', 'needs_answer', 'needs_document',
  'needs_policy_decision', 'needs_login', 'needs_verification', 'provider_unavailable',
  'retryable_failure', 'blocked_unsupported', 'submitting', 'submission_unknown',
  'submitted', 'failed', 'skipped', 'cancelled',
] as const;
export type ApplicationState = typeof APPLICATION_STATES[number];
export const SAFE_STAGES = ['screening', 'tailoring', 'filling', 'ready'] as const;
export type SafeStage = typeof SAFE_STAGES[number];
const waiting: readonly ApplicationState[] = [
  'needs_answer', 'needs_document', 'needs_policy_decision', 'needs_login', 'needs_verification',
  'provider_unavailable', 'retryable_failure', 'blocked_unsupported',
];
export function isWaitingState(state: ApplicationState): boolean { return waiting.includes(state); }
/** Failures a retry from the checkpoint can clear. `provider_inspect_required` came from a removed
 * fill/inspect model gate that parked answered forms; a real verification hold stays excluded. */
export function isSafeRetryState(state: ApplicationState, reasonCode: string | null): boolean {
  return state === 'provider_unavailable' || state === 'retryable_failure' ||
    (state === 'needs_verification' && reasonCode === 'provider_inspect_required');
}
export function isTerminalState(state: ApplicationState): boolean {
  return ['submitted', 'failed', 'skipped', 'cancelled'].includes(state);
}
export function canTransition(
  from: ApplicationState,
  to: ApplicationState,
  evidence: { artifactVerified?: boolean; formVerified?: boolean; submitPermit?: boolean; receiptVerified?: boolean; rejected?: boolean } = {},
): boolean {
  if (isTerminalState(from)) return false;
  if (from === 'submitting') return to === 'submission_unknown' ||
    (to === 'submitted' && evidence.receiptVerified === true) || (to === 'filling' && evidence.rejected === true);
  if (from === 'submission_unknown') return to === 'submitted' && evidence.receiptVerified === true;
  if (isWaitingState(from)) return false; // Resolution requires its own version-checked DAL operation.
  if (from === 'queued') return to === 'screening';
  if (isWaitingState(to) || ['failed', 'skipped', 'cancelled'].includes(to)) return true;
  if (from === to) return true;
  if (from === 'screening') return to === 'tailoring';
  if (from === 'tailoring') return to === 'filling' && evidence.artifactVerified === true;
  if (from === 'filling') return to === 'ready' && evidence.formVerified === true;
  return from === 'ready' && to === 'submitting' && evidence.submitPermit === true;
}
