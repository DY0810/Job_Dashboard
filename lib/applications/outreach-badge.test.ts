import { describe, expect, it } from 'vitest';
import { outreachBadge } from './badges.ts';

describe('outreachBadge', () => {
  it.each([
    ['sent', null, 'applied', 'sent'],
    ['sending', null, 'progress', 'sending'],
    ['failed', 'send_failed', 'failed', 'failed'],
    ['skipped', 'already_contacted', 'skipped', 'skipped'],
    ['draft', 'scheduled', 'queued', 'queued'],
    ['draft', 'awaiting_approval', 'approval', 'needs send'],
    ['draft', 'no_recipient', 'answer', 'needs address'],
    ['draft', 'outreach_disabled', 'cancelled', 'held'],
    ['draft', 'sender_not_configured', 'unsupported', 'no sender'],
    ['draft', null, 'approval', 'needs send'],
  ] as const)('%s (%s) -> %s', (status, reason, tone, label) => {
    expect(outreachBadge(status, reason)).toEqual({ tone, label });
  });
});
