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

/** A recruiter email's badge: a held draft says what it waits on, since each one asks for a different fix. */
const OUTREACH_HOLDS: Record<string, Badge> = {
  scheduled: { tone: 'queued', label: 'queued' },
  no_recipient: { tone: 'answer', label: 'needs address' },
  outreach_disabled: { tone: 'cancelled', label: 'held' },
  sender_not_configured: { tone: 'unsupported', label: 'no sender' },
};
export function outreachBadge(status: 'draft' | 'sending' | 'sent' | 'failed' | 'skipped', reason: string | null): Badge {
  if (status === 'sent') return { tone: 'applied', label: 'sent' };
  if (status === 'sending') return { tone: 'progress', label: 'sending' };
  if (status !== 'draft') return { tone: status, label: status };
  return OUTREACH_HOLDS[reason ?? ''] ?? { tone: 'approval', label: 'needs send' };
}
