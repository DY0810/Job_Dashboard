import { CITY_ALIASES, type NormalizedLocation } from './normalize.ts';

/**
 * GEO_TIER — the ONLY place geo is defined. Nothing else in the repo may hardcode a city, a
 * state or a tier. The city *alias* table lives in `normalize.ts` because it is spelling
 * normalization, not geography; `metros` below is its keys, so a fifth metro is added there
 * once and reaches this file on its own.
 *
 * Read by the Design tab, which shows every tier except `elsewhere`. Nothing sorts by these
 * numbers any more — they classify, they do not rank. That change raised the stakes: a tier
 * used to decide where a row sat, so a missed spelling cost a few positions; it now decides
 * whether the row exists at all. The tolerance that buys back the missed spellings lives in
 * `normalizeLocation`, which is upstream of `dedupe_key` as well as of this file — matching
 * loosely here instead would have left two spellings of one job as two postings.
 */
export const GEO_TIER = {
  /** `city_norm` values that count as a target metro: the alias keys `normalize.ts` emits. */
  metros: Object.keys(CITY_ALIASES) as readonly string[],
  /** The state whose every city counts, metro or not. */
  californiaCode: 'CA',
  metro: 0,
  /** Anywhere else in California — Sacramento and San Diego land here, not in `elsewhere`. */
  california: 1,
  remote: 2,
  /** The one tier the Design tab does not show. */
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
 * `is_remote` is parsed from the location string, `work_mode` comes from extraction, and they
 * disagree often ("London, United Kingdom" on a role the body says is remote). Remote is one
 * of the target tiers, so either signal is enough — requiring both to agree would drop real
 * matches, which is stricter than what was asked for.
 */
export function geoTier(location: NormalizedLocation, workMode: string | null = null): number {
  if (location.city_norm !== null && GEO_TIER.metros.includes(location.city_norm)) {
    return GEO_TIER.metro;
  }
  if (location.state === GEO_TIER.californiaCode) return GEO_TIER.california;
  if (location.is_remote || workMode === 'remote') return GEO_TIER.remote;
  if (location.city_norm === null && location.state === null && location.country === null) {
    return GEO_TIER.unknown;
  }
  return GEO_TIER.elsewhere;
}
