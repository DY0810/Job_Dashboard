import { describe, expect, it } from 'vitest';

import { POSTING_FIXTURES } from './classify.fixtures';
import { normalizeDescription } from './normalize';
import { isVoiceRole, voiceScore, VOICE_THRESHOLD } from './voice';

describe('voiceScore', () => {
  it('clears the threshold on a single high-weight term', () => {
    for (const term of ['barge-in', 'endpointing', 'turn detection']) {
      const body = `You will tune ${term} on our agent stack.`;
      expect(voiceScore(body), term).toBeGreaterThanOrEqual(VOICE_THRESHOLD);
      expect(isVoiceRole(body), term).toBe(true);
    }
  });

  it('needs two standard terms — one is not enough', () => {
    expect(isVoiceRole('Experience with WebRTC is a plus.')).toBe(false);
    expect(isVoiceRole('Experience with WebRTC and Twilio is a plus.')).toBe(true);
  });

  it('counts distinct terms, not occurrences', () => {
    expect(voiceScore('WebRTC. More WebRTC. So much WebRTC.')).toBe(1);
  });

  it('accepts a term hyphenated or spaced', () => {
    expect(voiceScore('barge in handling')).toBe(voiceScore('barge-in handling'));
    expect(voiceScore('speech to speech models')).toBe(voiceScore('speech-to-speech models'));
  });

  it('matches on word boundaries only', () => {
    // IVR inside "driver", TTS inside "watts", SIP inside "gossip".
    expect(voiceScore('Our drivers use the app; the unit draws 40 watts; office gossip.')).toBe(0);
    expect(voiceScore('We run an IVR and a TTS pipeline.')).toBe(2);
  });

  it('matches acronyms and vendor names case-sensitively', () => {
    // "sip" and "retell" are ordinary English words; SIP and Retell are not.
    expect(voiceScore('Sip your coffee and retell the customer story. We use Vapi.')).toBe(1);
    expect(voiceScore('We run SIP trunks and integrate Retell.')).toBe(2);
  });

  it('scores nothing for the adversarial negatives', () => {
    expect(voiceScore('Run our voice of the customer program with the insights team.')).toBe(0);
    expect(voiceScore('Keep our brand voice consistent across campaigns.')).toBe(0);
  });

  it('scores a posting that matches only on its title at 0', () => {
    const titleOnly = POSTING_FIXTURES.find((fixture) => fixture.title.includes('Voice'));
    expect(titleOnly, 'fixture set must contain a Voice title with a non-voice body').toBeDefined();
    // The title is never scored — but even if it were handed to the scorer, it is 0.
    expect(voiceScore(titleOnly!.title)).toBe(0);
    expect(voiceScore(normalizeDescription(titleOnly!.description))).toBe(0);
  });
});

describe('isVoiceRole over the hand-labeled fixture set', () => {
  it.each(POSTING_FIXTURES.map((fixture) => [fixture.id, fixture.title, fixture] as const))(
    'fixture %i (%s)',
    (_id, _title, fixture) => {
      expect(isVoiceRole(normalizeDescription(fixture.description))).toBe(fixture.voice);
    },
  );

  it('labels exactly three voice-AI roles, none of them by title', () => {
    const voiceFixtures = POSTING_FIXTURES.filter((fixture) => fixture.voice);
    expect(voiceFixtures).toHaveLength(3);
    for (const fixture of voiceFixtures) {
      expect(voiceScore(fixture.title), fixture.title).toBe(0);
    }
  });
});
