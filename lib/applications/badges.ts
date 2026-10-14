import { isAwaitingSubmitApproval, type ApplicationState } from './state.ts';

/** One badge per meaning the applicant acts on differently; `archived` is a view, not a state. */
export const BADGE_LABELS = {
  queued: 'queued', progress: 'in progress', answer: 'needs answer', document: 'needs document',
  approval: 'needs approval', login: 'needs login', verification: 'needs verification', retry: 'retry',
  unsupported: 'unsupported', unknown: 'unknown', applied: 'applied', failed: 'failed',
  skipped: 'skipped', cancelled: 'cancelled', archived: 'archived',
} as const;
export type BadgeTone = keyof typeof BADGE_LABELS;
export type Badge = { tone: BadgeTone; label: string };

const TONES: Record<ApplicationState, BadgeTone> = {
  queued: 'queued', screening: 'progress', tailoring: 'progress', filling: 'progress', ready: 'progress',
  submitting: 'progress', needs_answer: 'answer', needs_document: 'document',
  // A policy decision other than submit approval is answered like a question.
  needs_policy_decision: 'answer', needs_login: 'login', needs_verification: 'verification',
  provider_unavailable: 'retry', retryable_failure: 'retry', blocked_unsupported: 'unsupported',
  submission_unknown: 'unknown', submitted: 'applied', failed: 'failed', skipped: 'skipped', cancelled: 'cancelled',
};

export function statusBadge(state: ApplicationState, reasonCode: string | null): Badge {
  const tone = isAwaitingSubmitApproval(state, reasonCode) ? 'approval' : TONES[state];
  return { tone, label: BADGE_LABELS[tone] };
}
