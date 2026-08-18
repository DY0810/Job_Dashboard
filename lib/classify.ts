/**
 * Classification — one cached Haiku call per NEW posting.
 *
 * Two layers drop senior roles. A regex prefilter runs first and catches the obvious cases
 * without spending a call; the model classifies the survivors and drops the rest. Precision
 * from the regex, recall from the model.
 *
 * Cost control, in the order it applies:
 *   1. cache lookup on `sha256(normalizeDescription(body))` — a cached posting never touches
 *      the API, which is what makes a full re-poll cost ~$0 (finding B),
 *   2. regex prefilter — a senior posting never becomes a call,
 *   3. per-run spend cap — a running counter stops the loop cleanly, never throws.
 *
 * The model sits behind `ClassifyClient`, a one-function interface, so every pipeline test
 * runs against a stub: deterministic, offline, no API key. `anthropicClassifier()` is the
 * only implementation that talks to the network, and it is exercised by
 * `npm run enrich:smoke`, never by `npm test`.
 */

import { Anthropic } from '@anthropic-ai/sdk';
import { z } from 'zod';

import { enrichmentCacheKey } from './hash.ts';
import { normalizeDescription } from './normalize.ts';
import { isVoiceRole, VOICE_BADGE } from './voice.ts';

export const CLASSIFY_MODEL = 'claude-haiku-4-5-20251001';

/** Claude Haiku 4.5 list price, USD per million tokens. */
export const MODEL_PRICE_USD_PER_MTOK = { input: 1, output: 5 } as const;

/** Default cap when `WORKY_SPEND_CAP_USD` is unset. A run can never quietly cost more. */
export const DEFAULT_SPEND_CAP_USD = 1;

/**
 * Bodies longer than this are truncated before the call. A pathological 200KB posting is
 * worth no more tokens than a normal one — everything that decides the classification is in
 * the first few thousand words.
 */
export const MAX_DESCRIPTION_CHARS = 20_000;

const MAX_OUTPUT_TOKENS = 1500;

// ---------------------------------------------------------------------------------------
// Structured output
// ---------------------------------------------------------------------------------------

/**
 * The exact shape the model must return. `track: 'other'` and `seniority: 'senior+'` exist
 * so the model can say "neither of your tabs" and "too senior" — both are then dropped by
 * `toStored()` rather than stored. Without them the model is forced to mislabel.
 *
 * Everything is `.nullable()` and nothing is `.optional()`: structured outputs require every
 * property in `required`, and a missing field is indistinguishable from an unknown one.
 * `paid` is a nullable boolean — NULL *is* "unknown" (finding G). No sentinel string.
 */
export const ClassificationSchema = z.object({
  track: z.enum(['design', 'engineering', 'other']),
  seniority: z.enum(['entry', 'junior', 'mid', 'senior+']),
  employment_type: z
    .enum(['full-time', 'part-time', 'contract', 'freelance', 'internship'])
    .nullable(),
  internship_season: z.enum(['summer', 'fall', 'winter', 'spring']).nullable(),
  paid: z.boolean().nullable(),
  work_mode: z.enum(['remote', 'hybrid', 'onsite']).nullable(),
  location: z.string().nullable(),
  pay_rate: z
    .object({
      min: z.number().nullable(),
      max: z.number().nullable(),
      period: z.enum(['hour', 'week', 'month', 'year']).nullable(),
    })
    .nullable(),
  expected_grad: z.string().nullable(),
  /** Engineering only — the Design tab has no summary column, so none is generated. */
  summary: z.string().nullable(),
  responsibilities: z.array(z.string()),
  skills: z.array(z.string()),
  education: z.array(z.string()),
  badges: z.array(z.string()),
});

export type Classification = z.infer<typeof ClassificationSchema>;

/** What actually reaches `postings`: the dropped values are gone from the type. */
export interface StoredClassification extends Omit<Classification, 'track' | 'seniority'> {
  track: 'design' | 'engineering';
  seniority: 'entry' | 'junior' | 'mid';
}

/** Badges are filter chips, not free text. Anything else the model invents is discarded. */
export const ALLOWED_BADGES: readonly string[] = [
  'new-grad',
  'internship',
  'visa-sponsorship',
  'no-degree-required',
  'portfolio-required',
  'security-clearance',
];

/** The API wants a bare JSON Schema; zod owns the shape so the two can never drift. */
function classificationJsonSchema(): Record<string, unknown> {
  const schema = z.toJSONSchema(ClassificationSchema, { io: 'output' }) as Record<string, unknown>;
  delete schema.$schema; // the API wants the schema itself, not a schema document
  return schema;
}

export const CLASSIFY_SYSTEM_PROMPT = `You classify one job posting for a board that lists ONLY entry-level, junior and mid-level design and engineering roles, including internships and new-grad roles.

Return every field. Use null when the posting does not state something. Never guess.

track
  design      product, UX, UI, visual, motion, brand, graphic, industrial design, design research.
  engineering software, hardware, ML, data, infrastructure, QA, security engineering.
  other       anything else: product management, marketing, sales, recruiting, finance, support, operations, non-design research.
seniority
  entry    intern, co-op, apprentice, new grad, or no experience required.
  junior   roughly 0-2 years.
  mid      roughly 2-5 years.
  senior+  5 or more years, or a senior / staff / principal / lead / manager / director role.
  Judge the whole posting, not the title alone.
employment_type, internship_season
  Only when the posting states them.
paid
  true  when pay, salary, stipend or any compensation is stated.
  false ONLY when the posting says the role is unpaid, for course credit, or volunteer.
  null  when the posting says nothing about pay. null means unknown; do not infer.
work_mode, location
  As stated. location is the human-readable place string, or null for unspecified.
pay_rate
  Numbers only, no currency symbols or thousands separators, with the period they are quoted in. null when no figure is given. Use the same period the posting uses.
expected_grad
  The graduation date or window the posting asks for, as written. null otherwise.
summary
  ENGINEERING ONLY. One plain sentence, at most 25 words, describing what the person will build. null for design and for other.
responsibilities, skills
  Plain bullets, at most 6 each, describing what the job actually involves and what it actually requires. Copy substance, not marketing copy: never "fast-paced", "rockstar", "ninja", "unicorn", "world-class", "make an impact", "wear many hats", "like a family", "work hard play hard". A posting that says nothing concrete gets an empty array.
education
  Degree, field of study or graduation requirements. Empty array when there are none.
badges
  Zero or more of exactly: new-grad, internship, visa-sponsorship, no-degree-required, portfolio-required, security-clearance. Nothing else.`;

// ---------------------------------------------------------------------------------------
// Layer 1 — the regex prefilter
// ---------------------------------------------------------------------------------------

/**
 * Seniority words are matched against the TITLE only. "you will lead the redesign" and
 * "reports to the design manager" are ordinary body prose; in a title the same words are
 * decisive. `\b` keeps "lead" out of "leadership" and "sr" out of "usr".
 */
const SENIOR_TITLE =
  /\b(?:senior|sr|staff|principal|lead|director|manager|head\s+of|vp|vice\s+president)\b/i;

/**
 * "Member of Technical Staff" is a mid-level individual-contributor title, not a staff
 * engineer — and it is precisely the shape voice-AI roles come in, which is why the plan
 * names it twice. Strip the phrase before matching. "Senior Member of Technical Staff" still
 * trips `senior`, so nothing leaks.
 */
const TITLE_FALSE_FRIENDS = /\bmembers?\s+of\s+(?:the\s+)?technical\s+staff\b/gi;

/**
 * Years of experience, matched against title AND body, where the phrase actually appears.
 *
 * The capture is the LOW end of the requirement, because a range has to be read from its
 * start: "2-5 years" is the standard way to write a mid-level ask and must be kept, while
 * "5+ years" and "10 years" are senior. Matching the tail of the range instead — which a
 * bare `\b[5-9]` does, since a hyphen is a word boundary — silently drops most mid roles.
 *
 * ponytail: this still drops a body that happens to say "in the last 10 years we grew". A
 * false positive costs one listing; a leak costs the acceptance criterion. If it shows up in
 * practice, require an experience word within a few tokens rather than loosening the number.
 */
const YEARS_OF_EXPERIENCE = /\b(\d{1,2})(?:\s*(?:-|–|—|to)\s*\d{1,2})?\s*\+?\s*(?:years|yrs)\b/gi;

/** 5 or more years asked for, per the plan's `[5-9]+ years` / `\d{2}+ years` rule. */
const SENIOR_YEARS = 5;

function requiresSeniorExperience(text: string): boolean {
  for (const match of text.matchAll(YEARS_OF_EXPERIENCE)) {
    if (Number(match[1]) >= SENIOR_YEARS) return true;
  }
  return false;
}

/**
 * True when a posting is obviously senior and must never reach the model. Callers pass the
 * NORMALIZED body so the pattern sees text, not markup.
 */
export function isSeniorByRegex(
  title: string | null | undefined,
  normalizedDescription: string | null | undefined,
): boolean {
  const titleText = (title ?? '').replace(TITLE_FALSE_FRIENDS, ' ');
  if (SENIOR_TITLE.test(titleText)) return true;
  return requiresSeniorExperience(`${titleText} ${normalizedDescription ?? ''}`);
}

// ---------------------------------------------------------------------------------------
// Layer 2 — the model, behind an injectable interface
// ---------------------------------------------------------------------------------------

export interface ClassifyInput {
  title: string;
  company: string;
  /** Already normalized and truncated by the pipeline. */
  description: string;
}

export interface ClassifyCall {
  /** Whatever the model produced. The pipeline validates it; the client never does. */
  raw: unknown;
  inputTokens: number;
  outputTokens: number;
}

export type ClassifyClient = (input: ClassifyInput) => Promise<ClassifyCall>;

export function callCostUsd(inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens * MODEL_PRICE_USD_PER_MTOK.input) / 1_000_000 +
    (outputTokens * MODEL_PRICE_USD_PER_MTOK.output) / 1_000_000
  );
}

/**
 * The one implementation that talks to the network. The SDK client is constructed lazily, so
 * a fully cached run needs no `ANTHROPIC_API_KEY` at all.
 *
 * No prompt caching: Haiku 4.5's minimum cacheable prefix is 4096 tokens and this system
 * prompt is nowhere near it, so a `cache_control` breakpoint would silently do nothing.
 */
export function anthropicClassifier(): ClassifyClient {
  const schema = classificationJsonSchema();
  let client: Anthropic | undefined;

  return async ({ title, company, description }) => {
    client ??= new Anthropic();
    const message = await client.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: CLASSIFY_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema } },
      messages: [
        {
          role: 'user',
          content: `Title: ${title}\nCompany: ${company}\n\nPosting:\n${description}`,
        },
      ],
    });

    const text = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    return {
      raw: text ? safeJsonParse(text) : null,
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    };
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------------------

export interface EnrichPosting {
  id: number;
  title: string;
  company: string;
  description: string | null;
}

/** `sha256(normalizeDescription(body))` -> the raw classification. Survives posting deletion. */
export interface ClassificationCache {
  get(contentHash: string): unknown;
  set(contentHash: string, classification: Classification): void;
}

export type DropReason = 'prefilter-senior' | 'senior' | 'track' | 'empty' | 'invalid';

export interface EnrichResult {
  id: number;
  contentHash: string;
  /** null when the posting is dropped: nothing is stored on the row but `enriched_at`. */
  classification: StoredClassification | null;
  source: 'skipped' | 'prefilter' | 'cache' | 'model';
  dropReason?: DropReason;
}

export interface EnrichStats {
  /** Postings the loop actually reached. `processed + remaining === input length`. */
  processed: number;
  calls: number;
  cacheHits: number;
  prefilterDrops: number;
  dropped: number;
  stored: number;
  costUsd: number;
  /** Backlog left when the spend cap or a client error stopped the loop. */
  remaining: number;
  capReached: boolean;
  /** Set when a client error ended the run early. The postings before it are still written. */
  error?: string;
}

export interface EnrichOptions {
  client: ClassifyClient;
  cache: ClassificationCache;
  /** Per-run USD cap. Defaults to `DEFAULT_SPEND_CAP_USD`. */
  spendCapUsd?: number;
}

/**
 * Sequential on purpose: a running spend counter only means something if calls are not in
 * flight while it is being read. ~2k new postings a day at Haiku latency is minutes, not
 * hours, so there is nothing to win by parallelizing and a cap to lose.
 */
export async function enrichPostings(
  postings: readonly EnrichPosting[],
  options: EnrichOptions,
): Promise<{ results: EnrichResult[]; stats: EnrichStats }> {
  const { client, cache } = options;
  const spendCapUsd = options.spendCapUsd ?? DEFAULT_SPEND_CAP_USD;

  const results: EnrichResult[] = [];
  const stats: EnrichStats = {
    processed: 0,
    calls: 0,
    cacheHits: 0,
    prefilterDrops: 0,
    dropped: 0,
    stored: 0,
    costUsd: 0,
    remaining: 0,
    capReached: false,
  };

  for (const [index, posting] of postings.entries()) {
    const normalized = normalizeDescription(posting.description);
    const contentHash = enrichmentCacheKey(posting.description);

    if (!normalized) {
      results.push({ id: posting.id, contentHash, classification: null, source: 'skipped', dropReason: 'empty' });
      stats.processed += 1;
      stats.dropped += 1;
      continue;
    }

    // Cache lookup precedes everything, including the prefilter's bookkeeping.
    let classification = parseCached(cache.get(contentHash));
    let source: EnrichResult['source'] = classification ? 'cache' : 'prefilter';
    if (classification) stats.cacheHits += 1;

    // The cache key is the body alone (finding B), so two postings that share a boilerplate
    // body share a cache row — including a senior one and a junior one. The title-driven
    // prefilter therefore runs over cache hits too, where it costs nothing and is the only
    // thing standing between a shared body and a senior row in the UI.
    const senior = isSeniorByRegex(posting.title, normalized);

    if (!classification && !senior) {
      // ponytail: the cap is checked before the call, not after, so a run can overshoot by
      // at most one call (fractions of a cent on Haiku). Pre-call token estimation would
      // trade that for the opposite error.
      if (stats.costUsd >= spendCapUsd) {
        stats.capReached = true;
        stats.remaining = postings.length - index;
        break;
      }

      let call: ClassifyCall;
      try {
        call = await client({
          title: posting.title,
          company: posting.company,
          description: normalized.slice(0, MAX_DESCRIPTION_CHARS),
        });
      } catch (error) {
        // The SDK already retried the transient failures, so what reaches here is either
        // permanent (auth, bad request) or a sustained outage. Stop cleanly: everything
        // classified so far is still written, and the rest is retried next run.
        stats.error = error instanceof Error ? error.message : String(error);
        stats.remaining = postings.length - index;
        break;
      }

      stats.calls += 1;
      stats.costUsd += callCostUsd(call.inputTokens, call.outputTokens);
      source = 'model';

      const parsed = ClassificationSchema.safeParse(call.raw);
      if (!parsed.success) {
        // Not cached, and `runEnrich` leaves `enriched_at` NULL for this reason, so a
        // truncated or malformed answer is retried rather than frozen into a drop.
        results.push({ id: posting.id, contentHash, classification: null, source, dropReason: 'invalid' });
        stats.processed += 1;
        stats.dropped += 1;
        continue;
      }
      classification = parsed.data;
      cache.set(contentHash, classification);
    }

    const stored = classification && !senior ? toStored(classification, normalized) : null;
    results.push({
      id: posting.id,
      contentHash,
      classification: stored,
      source,
      dropReason: stored ? undefined : dropReasonFor(senior, classification),
    });
    stats.processed += 1;
    if (stored) {
      stats.stored += 1;
    } else {
      stats.dropped += 1;
      if (senior) stats.prefilterDrops += 1;
    }
  }

  if (!stats.capReached && stats.error === undefined) stats.remaining = 0;
  return { results, stats };
}

function dropReasonFor(senior: boolean, classification: Classification | null): DropReason {
  if (senior) return 'prefilter-senior';
  return classification?.track === 'other' ? 'track' : 'senior';
}

function parseCached(value: unknown): Classification | null {
  if (value === null || value === undefined) return null;
  const parsed = ClassificationSchema.safeParse(value);
  // A cache row written by an older schema is treated as a miss, not as a crash.
  return parsed.success ? parsed.data : null;
}

/**
 * The drop gate and the only place a row's stored shape is decided.
 *
 * - `track` other than design/engineering is dropped, not stored.
 * - `senior+` is dropped — the model is the second half of the two-layer filter.
 * - `summary` is nulled for design: the Design tab has no summary column.
 * - the `voice-ai` badge is applied here, after the cache read rather than inside the cached
 *   value, so retuning `VOICE_THRESHOLD` re-labels every posting without re-billing one.
 */
export function toStored(
  classification: Classification,
  normalizedDescription: string,
): StoredClassification | null {
  if (classification.track === 'other') return null;
  if (classification.seniority === 'senior+') return null;

  const track = classification.track;
  const badges = classification.badges.filter((badge) => ALLOWED_BADGES.includes(badge));
  if (track === 'engineering' && isVoiceRole(normalizedDescription)) badges.push(VOICE_BADGE);

  return {
    ...classification,
    track,
    seniority: classification.seniority,
    summary: track === 'engineering' ? classification.summary : null,
    badges: [...new Set(badges)],
  };
}

/**
 * `WORKY_SPEND_CAP_USD`. A trust boundary: an unparseable cap is an error, never a silent
 * zero (which would enrich nothing) or a silent Infinity (which would enrich everything).
 */
export function parseSpendCap(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_SPEND_CAP_USD;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`WORKY_SPEND_CAP_USD must be a non-negative number, got: ${raw}`);
  }
  return value;
}
