import { describe, expect, it } from 'vitest';
import { dailyStartInstant, formatDailyStart } from './schedule.ts';
import { archivedAt, bucket } from './buckets.ts';

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
    expect(archivedAt({ state: 'queued', hiddenAt: null, createdAt: now })).toBe(now + 14 * DAY);
    expect(archivedAt({ state: 'queued', hiddenAt: now, createdAt: 0 })).toBe(now);
  });
});
