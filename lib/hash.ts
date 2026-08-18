import { createHash } from 'node:crypto';

import { normalizeDescription } from './normalize.ts';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The enrichment cache key (finding B).
 *
 * Hashes the NORMALIZED description, never the raw body. Greenhouse escapes its HTML,
 * Lever splits the body across `descriptionPlain` + `lists[]`, Ashby returns markdown, and
 * every aggregator reflows whitespace — hashing raw text would re-bill the LLM for the same
 * job on every poll. This is the whole reason a full re-poll costs ~$0.
 *
 * The value is the primary key of `enrichment_cache`, which outlives the posting rows.
 */
export function enrichmentCacheKey(description: string | null | undefined): string {
  return sha256(normalizeDescription(description));
}
