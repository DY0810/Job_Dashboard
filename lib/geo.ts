import type { NormalizedLocation } from './normalize.ts';

/**
 * GEO_TIER — the ONLY place geo priority is defined. Nothing else in the repo may hardcode a
 * city or a tier. (The city *alias* tables live in `normalize.ts` because they are spelling
 * normalization, not ranking; `metros` below names the alias keys they produce.)
 *
 * Lower is better. Read by the Design tab sort only — Engineering is not geo-weighted.
 */
export const GEO_TIER = {
  /** `city_norm` alias keys that count as a target metro. */
  metros: ['sf', 'la', 'nyc', 'sea'] as readonly string[],
  metro: 0,
  /** Anywhere else in California — Sacramento and San Diego land here, not in `elsewhere`. */
  california: 1,
  remote: 2,
  elsewhere: 3,
} as const;

export function geoTier(location: NormalizedLocation): number {
  if (location.city_norm !== null && GEO_TIER.metros.includes(location.city_norm)) {
    return GEO_TIER.metro;
  }
  if (location.state === 'CA') return GEO_TIER.california;
  if (location.is_remote) return GEO_TIER.remote;
  return GEO_TIER.elsewhere;
}
