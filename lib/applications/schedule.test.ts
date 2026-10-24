import { describe, expect, it } from 'vitest';
import { dailyStartInstant, formatDailyStart, offlineNotice, scheduledWorker } from './schedule.ts';
import { archivedAt, bucket, inLive, isWatching, rowsBehind } from './buckets.ts';
import { APPLICATION_STATES, SUBMIT_APPROVAL, type ApplicationState } from './state.ts';
import { PARKED_STEPS } from './worker-protocol.ts';

const at = (iso: string) => Date.parse(iso);
const DAY = 86_400_000;

describe('dailyStartInstant', () => {
  it('follows New York across both DST changes', () => {
    // 2026-03-08: clocks jump 2:00 EST -> 3:00 EDT.
    expect(dailyStartInstant(at('2026-03-08T06:00:00Z'), 540, 'America/New_York')).toBe(at('2026-03-08T13:00:00Z'));
    expect(dailyStartInstant(at('2026-03-08T20:00:00Z'), 540, 'America/New_York')).toBe(at('2026-03-08T13:00:00Z'));
    expect(dailyStartInstant(at('2026-03-08T12:00:00Z'), 0, 'America/New_York')).toBe(at('2026-03-08T05:00:00Z'));
    // 2:30 does not exist that day; it lands within the skipped hour's neighbours.
    const gap = dailyStartInstant(at('2026-03-08T12:00:00Z'), 150, 'America/New_York');
    expect(gap).toBeGreaterThanOrEqual(at('2026-03-08T06:30:00Z'));
    expect(gap).toBeLessThanOrEqual(at('2026-03-08T07:30:00Z'));
    // 2026-11-01: clocks fall back 2:00 EDT -> 1:00 EST.
    expect(dailyStartInstant(at('2026-11-01T05:30:00Z'), 540, 'America/New_York')).toBe(at('2026-11-01T14:00:00Z'));
    expect(dailyStartInstant(at('2026-11-01T18:00:00Z'), 0, 'America/New_York')).toBe(at('2026-11-01T04:00:00Z'));
  });
  it('uses the local date, not the UTC date', () => {
    // 20:00Z on the 13th is already the 14th in Tokyo.
    expect(dailyStartInstant(at('2026-10-13T20:00:00Z'), 540, 'Asia/Tokyo')).toBe(at('2026-10-14T00:00:00Z'));
    // 02:00Z on the 14th is still the 13th in Los Angeles.
    expect(dailyStartInstant(at('2026-10-14T02:00:00Z'), 540, 'America/Los_Angeles')).toBe(at('2026-10-13T16:00:00Z'));
    expect(dailyStartInstant(at('2026-10-14T02:00:00.789Z'), 1439, 'UTC')).toBe(at('2026-10-14T23:59:00Z'));
  });
  it('formats the start for display', () => {
    expect([0, 540, 720, 1439].map(formatDailyStart)).toEqual(['12:00 AM', '9:00 AM', '12:00 PM', '11:59 PM']);
  });
});

describe('scheduledWorker', () => {
  it('picks the first online worker, else the first not revoked', () => {
    const revoked = { id: 'r', online: true, revokedAt: 1 }, idle = { id: 'i', online: false, revokedAt: null }, live = { id: 'l', online: true, revokedAt: null };
    expect(scheduledWorker([revoked, idle, live])).toBe(live);
    expect(scheduledWorker([revoked, idle])).toBe(idle);
    expect(scheduledWorker([revoked])).toBeUndefined();
    expect(scheduledWorker()).toBeUndefined();
  });
  it('says on Auto Apply when the applicant\'s worker is offline, and since when', () => {
    const seen = at('2026-10-22T03:27:00Z');
    const since = new Date(seen).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    expect(offlineNotice([{ online: false, revokedAt: null, lastSeenAt: seen }])).toBe(
      `Your worker is offline, last seen ${since}. Nothing is applied until it is back online.`);
    expect(offlineNotice([{ online: false, revokedAt: null, lastSeenAt: null }])).toBe('Your worker is offline. Nothing is applied until it is back online.');
    expect(offlineNotice([{ online: false, revokedAt: null, lastSeenAt: seen }, { online: true, revokedAt: null, lastSeenAt: seen }])).toBeNull();
    // A revoked worker is not the applicant's worker any more; with none paired there is nothing to be offline.
    expect(offlineNotice([{ online: false, revokedAt: seen, lastSeenAt: seen }])).toBeNull();
    expect(offlineNotice([])).toBeNull();
  });
});

describe('Live', () => {
  const now = at('2026-10-13T12:00:00Z');
  const row = (state: ApplicationState, reasonCode: string | null = null) => ({ state, reasonCode, hiddenAt: null });
  const shot = (age: number, step = 'Filling the form') => ({ updatedAt: now - age, step });
  it('keeps an approved form in Live, watchable once the worker opens it again to submit it', () => {
    expect(inLive(row('ready', 'submit_approved'))).toBe(true);
    expect(isWatching(row('ready', 'submit_approved'), shot(1_000, 'Opening the approved application'), now)).toBe(true);
  });
  // Apply or answers move the row on within seconds of the frame the worker posted as it parked the form.
  it('never shows the frame of a parked form as the worker filling it, however fresh', () => {
    expect(isWatching(row('ready', 'submit_approved'), shot(1_000, PARKED_STEPS.approval), now)).toBe(false);
    expect(isWatching(row('screening'), shot(1_000, PARKED_STEPS.answers), now)).toBe(false);
  });
  it('shows a fresh frame while the rows still hold the state from before the fill', () => {
    expect(isWatching(row('tailoring'), shot(1_000), now)).toBe(true);
    expect(isWatching(row('tailoring'), shot(30_000), now)).toBe(false);
  });
  it('never shows a parked, finished or archived row as being worked', () => {
    expect(isWatching(row('needs_policy_decision', SUBMIT_APPROVAL), shot(1_000), now)).toBe(false);
    expect(isWatching(row('skipped'), shot(1_000), now)).toBe(false);
    expect(inLive(row('needs_policy_decision', SUBMIT_APPROVAL))).toBe(true);
    expect(inLive(row('submitted'))).toBe(false);
    expect(inLive({ ...row('ready'), hiddenAt: now })).toBe(false);
  });
  it('names the rows a frame shows moved since they loaded, so Live reloads them', () => {
    const frame = { applicationId: 'a', state: 'filling' as ApplicationState };
    expect(rowsBehind([frame], [{ id: 'a', state: 'filling' }])).toBe('');
    expect(rowsBehind([frame], [{ id: 'a', state: 'queued' }])).toBe('a filling');
    expect(rowsBehind([frame, { applicationId: 'b', state: 'needs_policy_decision' }], [{ id: 'a', state: 'filling' }])).toBe('b needs_policy_decision');
  });
  // listLive sends frames only for rows in Live, so a submitted or skipped row's frame just stops coming.
  it('names the rows whose frame left the live list since the last poll', () => {
    const before = [{ applicationId: 'a', state: 'submitting' as ApplicationState }];
    expect(rowsBehind([], [{ id: 'a', state: 'submitting' }], before)).toBe('a left');
    expect(rowsBehind(before, [{ id: 'a', state: 'submitting' }], before)).toBe('');
    expect(rowsBehind([], [{ id: 'a', state: 'submitted' }], [])).toBe('');
  });
});

describe('bucket', () => {
  const now = at('2026-10-13T12:00:00Z');
  it('sorts rows into action, applied and archived, and drops old archives', () => {
    expect(bucket({ state: 'needs_document', hiddenAt: null, createdAt: now - 13 * DAY }, now)).toBe('action');
    expect(bucket({ state: 'queued', hiddenAt: null, createdAt: now - 14 * DAY }, now)).toBe('archived');
    expect(bucket({ state: 'failed', hiddenAt: null, createdAt: now - 43 * DAY }, now)).toBe('archived');
    expect(bucket({ state: 'failed', hiddenAt: null, createdAt: now - 44 * DAY }, now)).toBeNull();
    expect(bucket({ state: 'submitted', hiddenAt: null, createdAt: now - 400 * DAY }, now)).toBe('applied');
    expect(bucket({ state: 'submitted', hiddenAt: now - DAY, createdAt: now - 2 * DAY }, now)).toBe('archived');
    expect(bucket({ state: 'queued', hiddenAt: now - 30 * DAY, createdAt: now - 31 * DAY }, now)).toBeNull();
    // Mid-submission rows are never auto-archived, only by the applicant.
    expect(bucket({ state: 'submitting', hiddenAt: null, createdAt: now - 400 * DAY }, now)).toBe('action');
    expect(bucket({ state: 'submission_unknown', hiddenAt: null, createdAt: now - 400 * DAY }, now)).toBe('action');
    expect(bucket({ state: 'submission_unknown', hiddenAt: now - DAY, createdAt: now - 400 * DAY }, now)).toBe('archived');
    expect(archivedAt({ state: 'queued', hiddenAt: null, createdAt: now })).toBe(now + 14 * DAY);
    expect(archivedAt({ state: 'queued', hiddenAt: now, createdAt: 0 })).toBe(now);
  });
  // Live keeps a row the worker is on or the applicant must finish however old it is; Needs action used to drop it at 14 days.
  it('never archives a row Live shows, however old', () => {
    for (const state of APPLICATION_STATES) for (const reasonCode of [null, 'question_unresolved', SUBMIT_APPROVAL]) for (const age of [0, 20, 60]) {
      const app = { state, reasonCode, hiddenAt: null, createdAt: now - age * DAY };
      if (inLive(app)) expect(['action', 'applied'], `${state} ${reasonCode} ${age}d`).toContain(bucket(app, now));
    }
    expect(bucket({ state: 'needs_answer', reasonCode: 'question_unresolved', hiddenAt: null, createdAt: now - 60 * DAY }, now)).toBe('action');
    expect(bucket({ state: 'needs_answer', reasonCode: 'question_unresolved', hiddenAt: now - DAY, createdAt: now - 60 * DAY }, now)).toBe('archived');
  });
});
