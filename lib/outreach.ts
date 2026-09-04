/**
 * Cold-email drafts, handed to Gmail ready to address.
 *
 * The app fills the CLERICAL half — company, title, the posting URL — and deliberately
 * refuses to fill the human half. The bracketed slots stay bracketed: an email this tool
 * could send end to end with no typing is exactly the merge-field email a senior engineer
 * deletes unread. The draft is a scaffold, not a submission.
 *
 * BANNED from every string here, and from anything a human pastes in later:
 *  - the six résumé claims that have two conflicting live versions (MCP tool count, dispatch
 *    accuracy, voice cost, voice latency, regression-suite size, business outcome). Citing a
 *    number that contradicts the résumé already sent is worse than citing none.
 *  - the GRADUATION YEAR, which is unresolved between two résumé versions AND is an
 *    eligibility filter that must match every other application surface exactly. A
 *    summer-internship email is the likeliest place for it to leak.
 *
 * Nothing personal is hardcoded. The sender paragraph lives in the viewer's own browser,
 * not in this file, because this file ships in a public JS bundle — the deployment has no
 * auth, so anyone with the link gets it. The scaffolding can ship; the résumé prose cannot.
 * That also makes the board honest when two people share it: each signs as themselves.
 */

export type Sender = { name: string; intro: string };
export type Posting = { company: string; title: string; canonicalUrl: string };
export type OutreachKind = 'coffee' | 'referral';

/**
 * `to=` is present and EMPTY on purpose — Gmail puts the cursor in the To: field when it is
 * blank, which is the correct handoff. See `composeUrl` for why it is never filled.
 *
 * Bare `/mail/?`, never `/mail/u/0/`: the `u/0` form pins whichever Google account signed in
 * first, which is the wrong one for anybody with two.
 */
const GMAIL = 'https://mail.google.com/mail/?view=cm&fs=1&to=';

/**
 * `encodeURIComponent` per VALUE — never `encodeURI` over an assembled URL, which leaves
 * `&`, `+` and `#` raw. All three are live in this corpus: 1,600 titles contain `&`, and a
 * raw `&` truncates the subject at that character while a raw `#` turns everything after it
 * into a fragment the server never sees.
 *
 * Newlines stay `\n` → `%0A`. `%0D%0A` is an RFC 6068 requirement for `mailto:` and costs
 * twice the characters; this is not a `mailto:`.
 */
export function composeUrl(subject: string, body: string): string {
  return `${GMAIL}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * Gmail's list view truncates a subject around 70 characters and titles in this corpus run
 * to 160, so a long requisition string is DROPPED rather than shown cut in half.
 */
function shortTitle(title: string): string | null {
  return title.length <= 45 ? title : null;
}

export function compose(
  kind: OutreachKind,
  posting: Posting,
  sender: Sender,
): { subject: string; body: string } {
  const { company, title, canonicalUrl } = posting;

  if (kind === 'coffee') {
    const short = shortTitle(title);
    return {
      subject: short ? `Coffee chat — 15 minutes on ${short}?` : 'Coffee chat — 15 minutes?',
      body: `Hi —

[One sentence on something specific at ${company} you read, used, or noticed. If it survives a find-and-replace of the company name, it is not a hook — delete this draft and send nothing.]

${sender.intro}

I am applying to ${company} for ${title}, and I will do that through the posting either way — this is not about the application. What I cannot read in a posting is which part of the work there does not show up in it. Fifteen minutes, or just a reply to this email, would be genuinely useful.

The posting: ${canonicalUrl}

${sender.name}`,
    };
  }

  return {
    subject: 'Referral for a summer internship?',
    body: `Hi —

Thanks again for [the call] — the part about [specific thing they said] was genuinely useful, and I ended up [what you did with it].

${company} has ${title} open. I am applying either way, but if what you heard makes you comfortable referring me, I would be grateful — the internal form takes about a minute and I will send whatever else it asks for. If it is not something you can do off one conversation, a one-word no is a fine answer and I will not ask again.

The posting: ${canonicalUrl}

Resume attached.

${sender.name}`,
  };
}
