import type { NormalizedLocation } from './normalize.ts';

/**
 * GEO_TIER — the ONLY place geo is defined. Nothing else in the repo may hardcode a city or a
 * tier. (The city *alias* tables live in `normalize.ts` because they are spelling
 * normalization, not ranking; the keys below name the aliases they produce.)
 *
 * Read by the Design tab, which shows every tier except `elsewhere`. Nothing sorts by these
 * numbers any more — they classify, they do not rank. That change raised the stakes: a tier
 * used to decide where a row sat, so a missed spelling cost a few positions; it now decides
 * whether the row exists at all, which is why the matching below is deliberately tolerant.
 */
export const GEO_TIER = {
  /**
   * The target metros. The key is the `city_norm` value `normalize.ts` emits for a spelling it
   * recognizes; the phrase is what an *unrecognized* one still contains — "New York City",
   * "san francisco office" and "new york hq" all reach the database unaliased, and there are
   * more of those in a real corpus than there are clean ones.
   */
  metros: { sf: 'san francisco', la: 'los angeles', nyc: 'new york', sea: 'seattle' },
  metro: 0,
  /** Anywhere else in California — Sacramento and San Diego land here, not in `elsewhere`. */
  california: 1,
  remote: 2,
  elsewhere: 3,
  /**
   * Nothing usable in the location at all: no city, no state, no country, and not remote.
   * Deliberately distinct from `elsewhere` and deliberately *visible* on Design — "we could
   * not read this location" is a missing-data problem, and hiding those rows silently is a
   * worse failure than showing a handful that turn out to be somewhere else.
   */
  unknown: 4,
} as const;

/**
 * Whole-word containment. `' new york '` matches "new york city" and "new york hq" but not
 * "new yorkshire" — and the SQL mirror in `query.ts` runs the identical test as
 * `(' ' || city_norm || ' ') like '% new york %'`, which is why the padding is here and not
 * a regex.
 */
function hasPhrase(cityNorm: string, phrase: string): boolean {
  return ` ${cityNorm} `.includes(` ${phrase} `);
}

export function isTargetMetro(cityNorm: string | null): boolean {
  if (cityNorm === null) return false;
  return Object.entries(GEO_TIER.metros).some(
    ([alias, phrase]) => cityNorm === alias || hasPhrase(cityNorm, phrase),
  );
}

/**
 * `is_remote` is parsed from the location string, `work_mode` comes from extraction, and they
 * disagree often ("London, United Kingdom" on a role the body says is remote). Remote is one
 * of the target tiers, so either signal is enough — requiring both to agree would drop real
 * matches, which is stricter than what was asked for.
 */
export function geoTier(location: NormalizedLocation, workMode: string | null = null): number {
  if (isTargetMetro(location.city_norm)) return GEO_TIER.metro;
  if (location.state === 'CA') return GEO_TIER.california;
  if (location.is_remote || workMode === 'remote') return GEO_TIER.remote;
  if (location.city_norm === null && location.state === null && location.country === null) {
    return GEO_TIER.unknown;
  }
  return GEO_TIER.elsewhere;
}
