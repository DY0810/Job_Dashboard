import { describe, expect, it } from 'vitest';

import { GEO_TIER, geoTier } from './geo.ts';
import { CITY_ALIASES, normalizeLocation } from './normalize.ts';

const tierOf = (location: string) => geoTier(normalizeLocation(location));

describe('GEO_TIER', () => {
  const aliases = Object.values(CITY_ALIASES).flatMap((entry) => entry.aliases);

  it.each(aliases)('puts %s in tier 0', (alias) => {
    expect(tierOf(alias)).toBe(GEO_TIER.metro);
    expect(tierOf(alias)).toBe(0);
  });

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

  it.each(['Berlin', 'Berlin, Germany', 'Austin, TX', 'London', 'New Orleans, LA', ''])(
    'puts %s in tier 3',
    (location) => {
      expect(tierOf(location)).toBe(GEO_TIER.elsewhere);
      expect(tierOf(location)).toBe(3);
    },
  );

  it('ranks a metro above the rest of California, remote, and elsewhere', () => {
    expect(GEO_TIER.metro).toBeLessThan(GEO_TIER.california);
    expect(GEO_TIER.california).toBeLessThan(GEO_TIER.remote);
    expect(GEO_TIER.remote).toBeLessThan(GEO_TIER.elsewhere);
  });
});
