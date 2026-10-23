import { isAwaitingSubmitApproval, type ApplicationState } from './state.ts';
import type { DiscoveryStatus } from './discovery-protocol.ts';
import type { Run } from './worker-protocol.ts';

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

type Discovery = Pick<DiscoveryStatus, 'state' | 'errorCode' | 'heldQuestions'>;
const STALE = 'POLICY_STALE';
const words = (code: string) => code.toLowerCase().replaceAll('_', ' ');

/** What a queued row waits on: a run that will not start it, or its turn under the caps. */
export function queuedDetail(run: Pick<Run, 'state'> | undefined, status: Pick<DiscoveryStatus, 'errorCode'> | undefined,
  caps: { perEmployerCap: number; dailyApplicationCap: number }) {
  // Stopping a run cancels its queued rows, and the next run queues them again.
  if (run && run.state !== 'running') return 'Its run is paused, so it will not start. Resume the run under Runs in Settings, or stop it and start auto apply again.';
  if (status?.errorCode === STALE) return 'It will not start: your Auto Apply policy changed after its run started. Stop that run under Runs in Settings, then start auto apply again.';
  return `Waiting its turn. It starts on its own, up to ${caps.perEmployerCap} per employer and ${caps.dailyApplicationCap} a day.`;
}

/** Why a running run finds or starts nothing; null while its discovery works. */
export function discoveryProblem(status: Discovery) {
  if (status.errorCode === STALE) return 'A run started before your last Auto Apply policy change finds and starts nothing. Stop it under Runs in Settings, then start auto apply again.';
  if (status.errorCode || status.state === 'failed') {
    return `Auto Apply could not finish looking for new roles (${words(status.errorCode ?? 'failed')}). It tries again each minute while the worker is online.`;
  }
  return null;
}

const HELD_REASONS: Record<string, string> = {
  pay_undisclosed: 'pay not listed', pay_currency_or_period_unverified: 'pay in another currency or period than your floor',
  pay_floor_unverified: 'pay may be under your floor', pay_evidence_invalid: 'pay unreadable', country_unknown: 'country not listed',
};
/** Roles discovery holds until the applicant changes the policy, and why; null when none are held. */
export function heldForDecision(status: Discovery) {
  const held = Object.entries(status.heldQuestions);
  if (!held.length) return null;
  return `Held until you decide: ${held.map(([code, count]) => `${HELD_REASONS[code] ?? words(code)} (${count})`).join(', ')}. ` +
    'Auto Apply does not start these roles under your current policy. To include them, change it in Profile.';
}
