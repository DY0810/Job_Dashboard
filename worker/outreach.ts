import type { StructuredGenerationResult } from './providers.ts';

type Letter = Extract<StructuredGenerationResult, { task: 'cover_letter' }>;

// Hosts in a posting that are not the employer: job boards, social sites, government notices.
const NOT_EMPLOYER = /(^|\.)(greenhouse\.io|lever\.co|ashbyhq\.com|myworkdayjobs\.com|workday\.com|icims\.com|jobvite\.com|smartrecruiters\.com|linkedin\.com|glassdoor\.com|indeed\.com|joinhandshake\.com|google\.com|youtube\.com|twitter\.com|x\.com|facebook\.com|instagram\.com|github\.com|medium\.com|bit\.ly)$|\.(gov|edu|mil)$/;

/** Recruiting inboxes and employer domains named in the official posting, for the server's lookup. */
export function postingContacts(description: string) {
  const emails = [...new Set((description.match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi) ?? []).map((email) => email.toLowerCase()))];
  const hosts = [...description.matchAll(/\bhttps?:\/\/(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})/gi)].map((match) => match[1].toLowerCase());
  return {
    emails: emails.filter((email) => /recruit|talent|university|campus|intern|early|career|jobs|hiring/.test(email.split('@')[0]) &&
      !/no-?reply/.test(email)).slice(0, 5),
    domains: [...new Set([...emails.map((email) => email.split('@')[1]), ...hosts])].filter((domain) => !NOT_EMPLOYER.test(domain)).slice(0, 5),
  };
}

const firstSentences = (text: string, count: number) => text.split(/(?<=[.!?])\s+/).slice(0, count).join(' ').trim();

type Track = 'engineering' | 'design';

/**
 * The note a recruiter gets a few days after an application (docs/research/2026-10-05-cold-email-research.md):
 * the role in the subject, one proof from the tailored letter, one direct ask, and the work link the
 * track is judged on. Plain text and at most 120 words. The server adds "Hi <name>," once it knows who reads it.
 */
export function outreachDraft(input: { track: Track; company: string; role: string; name: string;
  linkedin?: string; github?: string; portfolio?: string; letter?: Letter }) {
  const evidence = input.letter?.body[0]?.text ?? '';
  const work = input.track === 'design'
    ? (input.portfolio ? `Portfolio: ${input.portfolio}` : '')
    : (input.github ? `GitHub: ${input.github}` : '');
  const draft = (proof: string) => ({
    subject: `Applied: ${[input.role, input.name].filter(Boolean).join(' – ')}`,
    body: [
      `I recently applied for the ${input.role} role at ${input.company}.${proof ? ` ${proof}` : ''}`,
      ...(work ? [work] : []),
      `I'd appreciate being considered. If someone else handles this role, could you point me to them?`,
      ['Thanks,', input.name, input.linkedin].filter(Boolean).join('\n'),
    ].join('\n\n'),
  });
  // Two sentences, else one, else none: the note never runs past 120 words.
  return [firstSentences(evidence, 2), firstSentences(evidence, 1), ''].map(draft)
    .find((note) => note.body.split(/\s+/).filter(Boolean).length <= 120)!;
}
