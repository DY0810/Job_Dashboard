import { describe, expect, it } from 'vitest';

import { GEO_TIER, geoTier } from './geo.ts';
import { CITY_ALIASES, normalizeLocation } from './normalize.ts';

const tierOf = (location: string, workMode: string | null = null) =>
  geoTier(normalizeLocation(location), workMode);

describe('GEO_TIER', () => {
  const aliases = Object.values(CITY_ALIASES).flatMap((entry) => entry.aliases);

  it.each(aliases)('puts %s in tier 0', (alias) => {
    expect(tierOf(alias)).toBe(GEO_TIER.metro);
    expect(tierOf(alias)).toBe(0);
  });

  /**
   * The spellings a real board sends that `normalize.ts` has no alias for. These used to cost
   * a few sort positions; now they decide whether a Design posting exists at all, which is
   * why the match is on whole words inside `city_norm` rather than on set membership.
   */
  it.each([
    'New York City, New York, United States',
    'New York HQ',
    'New York Office',
    'San Francisco Office',
    'South San Francisco',
    'Seattle Office',
    'Los Angeles Metro Area',
  ])('puts %s in tier 0 despite the unaliased spelling', (location) => {
    expect(tierOf(location)).toBe(GEO_TIER.metro);
  });

  // The over-match direction, which is what a substring test would get wrong.
  it.each(['New Yorkshire', 'New Orleans, LA', 'Seattletonia', 'York'])(
    'does not let %s into tier 0',
    (location) => {
      expect(tierOf(location)).not.toBe(GEO_TIER.metro);
    },
  );

  // The case a naive implementation fails: California, but not a named metro.
  it.each(['Sacramento', 'San Diego', 'San Diego, CA', 'Fresno', 'Oakland'])(
    'puts %s in tier 1',
    (city) => {
      expect(tierOf(city)).toBe(GEO_TIER.california);
      expect(tierOf(city)).toBe(1);
    },
  );

  it.each(['Remote', 'Work from home', 'Anywhere in the World', 'Distributed'])(
    'puts %s in tier 2',
    (location) => {
      expect(tierOf(location)).toBe(GEO_TIER.remote);
      expect(tierOf(location)).toBe(2);
    },
  );

  /** `is_remote` comes from the location string and `work_mode` from extraction; they
   *  disagree on ~100 live postings. Either one is enough to count as remote. */
  it('takes work_mode as a remote signal on its own', () => {
    expect(tierOf('London, United Kingdom')).toBe(GEO_TIER.elsewhere);
    expect(tierOf('London, United Kingdom', 'remote')).toBe(GEO_TIER.remote);
    expect(tierOf('London, United Kingdom', 'hybrid')).toBe(GEO_TIER.elsewhere);
  });

  it.each(['Berlin', 'Berlin, Germany', 'Austin, TX', 'London', 'New Orleans, LA'])(
    'puts %s in tier 3',
    (location) => {
      expect(tierOf(location)).toBe(GEO_TIER.elsewhere);
      expect(tierOf(location)).toBe(3);
    },
  );

  /** Deliberately its own tier, and deliberately not `elsewhere`: "we could not read this
   *  location" is missing data, and the Design tab shows it rather than dropping it. */
  it.each(['', '   '])('puts %s in the unknown tier, not elsewhere', (location) => {
    expect(tierOf(location)).toBe(GEO_TIER.unknown);
    expect(tierOf(location)).not.toBe(GEO_TIER.elsewhere);
  });

  /** The boundary, stated so nobody widens it by accident: "unknown" means the row carries no
   *  location at all. A placeholder string still normalizes to a city slug, and "tbd" is not
   *  distinguishable from "berlin" without a list of placeholders to guess from. */
  it.each(['Germany', 'TBD'])('puts %s in elsewhere rather than unknown', (location) => {
    expect(tierOf(location)).toBe(GEO_TIER.elsewhere);
  });

  it('orders a metro above the rest of California, remote, and elsewhere', () => {
    expect(GEO_TIER.metro).toBeLessThan(GEO_TIER.california);
    expect(GEO_TIER.california).toBeLessThan(GEO_TIER.remote);
    expect(GEO_TIER.remote).toBeLessThan(GEO_TIER.elsewhere);
    expect(GEO_TIER.unknown).not.toBe(GEO_TIER.elsewhere);
  });
});
