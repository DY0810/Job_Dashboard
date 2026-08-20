/**
 * Which chips one table row shows, in render order.
 *
 * Pulled out of `app/page.tsx` so the decision is testable without the page — the page pulls
 * in the database and `next/navigation`, and this is a pure list operation over a row.
 *
 * The row carries the same fact in two places: `employment_type` is a column and `badges` is a
 * JSON array, and the enricher writes `internship` into both for every internship posting
 * (`extractBadges` pushes it whenever the type is `internship`). Rendering both fields verbatim
 * therefore printed "internship" twice on 293 live postings.
 */

import type { Group } from './params.ts';

/** Just the fields the badge cell reads. Structural, so `Row` from `query.ts` satisfies it. */
export interface ChipRow {
  employmentType: string | null;
  workMode: string | null;
  paid: boolean | null;
  internshipSeason: string | null;
  seniority: string | null;
  badges: string[] | null;
}

/**
 * A chip is either a filter value (pressable, belongs to a filter group) or a free badge slug.
 * `group: null` marks the badge, which routes through `?badge=` rather than a group filter.
 */
export interface Chip {
  group: Group | null;
  value: string;
}

/**
 * `tab` decides one chip only: Engineering carries seniority in its own column, so the level
 * rides along as a chip on Design alone.
 */
export function rowChips(row: ChipRow, tab: 'design' | 'engineering'): Chip[] {
  const chips: Chip[] = [];

  if (row.employmentType) chips.push({ group: 'type', value: row.employmentType });
  if (row.workMode) chips.push({ group: 'mode', value: row.workMode });
  // `paid = null` is "the posting does not say" — it claims neither chip (finding G).
  if (row.paid !== null) chips.push({ group: 'pay', value: row.paid ? 'paid' : 'unpaid' });
  if (row.internshipSeason) chips.push({ group: 'season', value: row.internshipSeason });
  if (tab === 'design' && row.seniority) chips.push({ group: 'level', value: row.seniority });

  for (const badge of row.badges ?? []) chips.push({ group: null, value: badge });

  // One label, one chip. The first occurrence wins, which is deliberate rather than incidental:
  // the filter chips are pushed above the badges, and a filter chip is pressable through its own
  // group while a badge routes through `?badge=`, so keeping the earlier one keeps the more
  // useful control. Written as a general rule rather than a special case for `internship`,
  // because the collision is structural — two fields encoding one fact — and nothing stops a
  // future badge from restating `remote` or `paid` the same way.
  const seen = new Set<string>();
  return chips.filter((chip) => !seen.has(chip.value) && seen.add(chip.value));
}
