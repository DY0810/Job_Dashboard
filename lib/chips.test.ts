/**
 * The badge cell. One rule carries the weight: a row must never print the same word twice.
 *
 * The row holds the same fact in two shapes — `employment_type` as a column, `badges` as a JSON
 * array — and the enricher writes `internship` into both for every internship posting. Rendering
 * the two fields verbatim printed "internship internship" on 293 live postings, which is what
 * this file exists to stop.
 */

import { describe, expect, it } from 'vitest';

import { rowChips, type ChipRow } from './chips.ts';

const ROW: ChipRow = {
  employmentType: null,
  workMode: null,
  paid: null,
  internshipSeason: null,
  seniority: null,
  badges: null,
};

const labels = (row: Partial<ChipRow>, tab: 'design' | 'engineering' = 'engineering') =>
  rowChips({ ...ROW, ...row }, tab).map((chip) => chip.value);

describe('rowChips', () => {
  /** The reported bug, at the seam that produces it. */
  it.each(['design', 'engineering'] as const)(
    'never repeats a label on %s — the internship case',
    (tab) => {
      const shown = labels({ employmentType: 'internship', badges: ['internship'] }, tab);
      expect(shown).toEqual([...new Set(shown)]);
      expect(shown.filter((l) => l === 'internship')).toHaveLength(1);
    },
  );

  /** The general rule, not just the one collision that exists today. */
  it('never repeats a label whatever the badge list restates', () => {
    const shown = labels({
      employmentType: 'internship',
      workMode: 'remote',
      paid: true,
      internshipSeason: 'summer',
      badges: ['internship', 'remote', 'paid', 'summer', 'visa-sponsorship'],
    });
    expect(shown).toEqual([...new Set(shown)]);
    expect(shown).toContain('visa-sponsorship');
  });

  it('keeps the filter chip rather than the badge when they collide', () => {
    // The filter chip is pressable through its group; the badge routes through `?badge=`.
    // Keeping the first occurrence keeps the more useful control.
    const chips = rowChips(
      { ...ROW, employmentType: 'internship', badges: ['internship'] },
      'engineering',
    );
    expect(chips.find((c) => c.value === 'internship')?.group).toBe('type');
  });

  it('still shows every distinct badge', () => {
    expect(
      labels({ employmentType: 'internship', badges: ['internship', 'portfolio-required'] }),
    ).toEqual(['internship', 'portfolio-required']);
  });

  it('renders the fields in the documented order', () => {
    expect(
      labels(
        {
          employmentType: 'full-time',
          workMode: 'hybrid',
          paid: true,
          internshipSeason: 'summer',
          seniority: 'entry',
          badges: ['visa-sponsorship'],
        },
        'design',
      ),
    ).toEqual(['full-time', 'hybrid', 'paid', 'summer', 'entry', 'visa-sponsorship']);
  });

  it('carries the level on Design only — Engineering has a column for it', () => {
    expect(labels({ seniority: 'mid' }, 'design')).toEqual(['mid']);
    expect(labels({ seniority: 'mid' }, 'engineering')).toEqual([]);
  });

  it('omits pay entirely when the posting does not say', () => {
    expect(labels({ paid: null })).toEqual([]);
    expect(labels({ paid: false })).toEqual(['unpaid']);
  });
});
