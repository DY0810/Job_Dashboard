/**
 * Voice-AI detection — a weighted keyword scorer over the NORMALIZED DESCRIPTION BODY.
 *
 * Never the title. Voice-AI titles are "Member of Technical Staff", "Forward Deployed
 * Engineer", "Applied AI Engineer"; the signal is in the body or it is nowhere. A posting
 * that matches only on its title scores 0 — asserted directly in `voice.test.ts`.
 *
 * Callers pass `normalizeDescription(body)`. The scorer does no normalization of its own so
 * that the cache key, the classifier prompt and this scorer all see the same string.
 *
 * Voice roles surface in the Engineering tab with a `voice-ai` badge. There is no third tab.
 */

/** One high-weight term, or two standard terms. The single tunable constant. */
export const VOICE_THRESHOLD = 2;

/** The badge a matching engineering posting carries. Also a filter chip (phase 8). */
export const VOICE_BADGE = 'voice-ai';

const HIGH_WEIGHT = 2;
const STANDARD_WEIGHT = 1;

/** Near-zero false-positive rate: nobody writes these unless they build voice agents. */
const HIGH_WEIGHT_TERMS = ['barge-in', 'endpointing', 'turn detection'] as const;

const STANDARD_TERMS = [
  'telephony',
  'SIP',
  'WebRTC',
  'latency budget',
  'ASR',
  'STT',
  'TTS',
  'speech-to-speech',
  'diarization',
  'LiveKit',
  'Pipecat',
  'Twilio',
  'Vapi',
  'Retell',
  'Deepgram',
  'Cartesia',
  'ElevenLabs',
  'voice agent',
  'conversational AI',
  'IVR',
] as const;

/**
 * Terms that are ordinary English words when lowercased. Matched case-sensitively, or "sip
 * your coffee" and "retell the customer's story" score as voice-AI signal. The remaining
 * vendor names (Twilio, Deepgram, …) are not English words, so case does not matter for them.
 */
const CASE_SENSITIVE_TERMS = new Set(['SIP', 'ASR', 'STT', 'TTS', 'IVR', 'Retell']);

/**
 * Whole-word matching. `IVR` must not fire inside "driver" and `TTS` must not fire inside
 * another token, so every term is anchored with `\b`. Internal spaces and hyphens are
 * interchangeable — "barge-in" and "barge in" are the same term — because ATS bodies
 * reflow both ways.
 */
function termPattern(term: string): RegExp {
  const body = term
    .split(/[\s-]+/)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[\\s-]+');
  return new RegExp(`\\b${body}\\b`, CASE_SENSITIVE_TERMS.has(term) ? '' : 'i');
}

const HIGH_WEIGHT_PATTERNS = HIGH_WEIGHT_TERMS.map(termPattern);
const STANDARD_PATTERNS = STANDARD_TERMS.map(termPattern);

/**
 * Sum of the weights of the DISTINCT terms present. Repeating "WebRTC" twelve times still
 * scores 1 — a posting has to mention two different things to clear the threshold.
 */
export function voiceScore(normalizedDescription: string | null | undefined): number {
  const text = normalizedDescription ?? '';
  if (!text) return 0;

  let score = 0;
  for (const pattern of HIGH_WEIGHT_PATTERNS) if (pattern.test(text)) score += HIGH_WEIGHT;
  for (const pattern of STANDARD_PATTERNS) if (pattern.test(text)) score += STANDARD_WEIGHT;
  return score;
}

export function isVoiceRole(normalizedDescription: string | null | undefined): boolean {
  return voiceScore(normalizedDescription) >= VOICE_THRESHOLD;
}
