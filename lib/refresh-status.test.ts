import { describe, expect, it } from 'vitest';
import { phaseFromLog } from './refresh-status.ts';

const T0 = Date.parse('2026-08-21T10:00:00Z');
const L = (...lines: string[]) => lines.join('\n');

describe('phaseFromLog', () => {
  it('is idle until a cycle starts after the lock', () => {
    expect(phaseFromLog('', T0)).toBe('idle');
    expect(phaseFromLog(L('[2026-08-21T09:00:00Z] cycle start', '[2026-08-21T09:03:00Z] cycle end'), T0)).toBe('idle');
  });

  it('walks the markers in order', () => {
    const start = '[2026-08-21T10:00:01Z] cycle start';
    expect(phaseFromLog(L(start), T0)).toBe('ingesting');
    expect(phaseFromLog(L(start, '{"run":"x","event":"summary","connectors":9}'), T0)).toBe('enriching');
    expect(phaseFromLog(L(start, '{"event":"summary"}', 'enrich: 17 processed, 2 stored'), T0)).toBe('syncing');
    expect(phaseFromLog(L(start, '{"event":"summary"}', 'enrich: 17 processed', '[2026-08-21T10:04:00Z] cycle end'), T0)).toBe('done');
  });

  it('reads only the latest cycle, not the one before it', () => {
    const log = L(
      '[2026-08-21T09:00:00Z] cycle start', '{"event":"summary"}', 'enrich: old', '[2026-08-21T09:03:00Z] cycle end',
      '[2026-08-21T10:00:00Z] cycle start',
    );
    expect(phaseFromLog(log, T0)).toBe('ingesting');
  });

  it('tolerates the lock being taken a moment before the line is written', () => {
    expect(phaseFromLog('[2026-08-21T09:59:59Z] cycle start', T0)).toBe('ingesting');
  });
});
