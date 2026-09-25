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

const firstSentences = (text: string, count: number) => (text.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [text]).slice(0, count).join(' ').trim();

/**
 * The note a recruiter gets after an application: the tailored letter's strongest evidence and its
 * company paragraph, then a short ask. The server adds "Hi <name>," once it knows who reads it.
 */
export function outreachDraft(input: { company: string; role: string; name: string; linkedin?: string; letter?: Letter }) {
  return {
    subject: `Following up on my ${input.role} application`,
    body: [
      `I just applied for the ${input.role} role at ${input.company} and wanted to reach out directly.`,
      ...(input.letter ? [firstSentences(input.letter.body[0].text, 2), input.letter.companyParagraph]
        : ["I'd love to learn more about the team and what the role involves."]),
      'Would you be open to a quick 15-minute call about the role or the team? If someone else is handling this position, I would appreciate it if you could point me in the right direction.',
      ['Thank you,', input.name, input.linkedin].filter(Boolean).join('\n'),
    ].join('\n\n'),
  };
}
