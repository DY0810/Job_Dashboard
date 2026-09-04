/**
 * Cold-email drafts, addressed and handed to Gmail.
 *
 * WHAT THE EVIDENCE ACTUALLY SUPPORTS, because most of this genre does not survive contact
 * with it. A deep pass over the cold-email literature refuted 21 of 27 candidate claims:
 * nothing measured survived on optimal word count, subject-line form, personalisation lift,
 * plain-text vs HTML, send timing, or "phrases that kill replies". Those are craft here, and
 * this file must never imply otherwise. What did survive is all about referrals:
 *
 *  - A referral is worth 2x-6x on hire rate (Burks et al., QJE 2015, 1.5M+ applicants) — but
 *    that measures a referral once OBTAINED, not the odds a cold ask produces one.
 *  - Referral supply is rationed by the referrer's willingness to attach their NAME, not by
 *    awareness or incentive: a pre-registered RCT across 238 stores found bigger bonuses
 *    bought more referrals of worse quality (Friebel et al., JPE 2023). So the referral ask
 *    owes underwriting material, not rapport.
 *  - A filler "because" earns nothing once a favour takes effort — Langer's placebic reason
 *    produced compliance identical to no reason at all (.24 vs .24) in the effortful cell.
 *    Every reason in these templates has to be a real one.
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

/**
 * The half of the email that is the same whoever you write to, plus the mailbox it leaves
 * from. `compose` ignores `from` — only `/api/send` uses it — but it is stored here because
 * it is part of the same per-device identity: two people share this board, and each one signs
 * as themselves AND sends from their own Gmail.
 */
export type Sender = { name: string; intro: string; from: string };
/** Typed once per posting: you are writing to a different person at every company. */
export type Recipient = { name: string; email: string };
export type Posting = { company: string; title: string; canonicalUrl: string };
export type OutreachKind = 'coffee' | 'referral';

/**
 * Your outline. Every field is optional, and an empty one leaves its bracket in the draft
 * rather than closing over silently — which is the property that keeps a half-filled draft
 * obviously unfinished instead of quietly sendable.
 *
 * These are the slots the templates cannot fill for you: what you actually noticed about the
 * company, how you met, and the concrete evidence a referrer would be staking their name on.
 */
export type Outline = {
  /** coffee: the one specific thing about this company you can point at. */
  hook?: string;
  /** referral: how you and this person actually met. */
  met?: string;
  /** referral: the thing they said that stuck. */
  said?: string;
  /** referral: what you did about it afterwards. */
  didWith?: string;
  /** referral: up to three concrete reasons the referrer would be right about you. */
  fit?: string[];
};

/**
 * A filled slot, or its bracket. The bracket is not a placeholder to be tidied away later —
 * it is the mechanism that stops an unfinished draft looking finished, so it must survive an
 * empty value rather than collapsing to nothing.
 */
function slot(value: string | undefined, placeholder: string): string {
  const filled = value?.trim();
  return filled && filled.length > 0 ? filled : `[${placeholder}]`;
}

/**
 * `to=` is filled from the address you type while looking at the person. Workie still does
 * not FIND anyone — 62% of canonical URLs are ATS hosts so no employer domain is derivable,
 * there is no company-domain column, and 85% of the addresses in descriptions are
 * accommodations inboxes. Finding the human stays manual; typing it twice does not.
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
export function composeUrl(to: string, subject: string, body: string): string {
  return `${GMAIL}${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
  recipient: Recipient,
  outline: Outline = {},
): { subject: string; body: string } {
  const { company, title, canonicalUrl } = posting;
  // A name in the greeting is the one personalisation this tool can guarantee is real,
  // because a human typed it while looking at the person.
  const greeting = `Hi ${recipient.name.split(/\s+/)[0]} —`;

  if (kind === 'coffee') {
    const short = shortTitle(title);
    return {
      subject: short ? `Coffee chat — 15 minutes on ${short}?` : 'Coffee chat — 15 minutes?',
      body: `${greeting}

${slot(outline.hook, `One sentence on something specific at ${company} you read, used, or noticed. If it survives a find-and-replace of the company name, it is not a hook — delete this draft and send nothing.`)}

${sender.intro}

I am applying to ${company} for ${title}, and I will do that through the posting either way — this is not about the application. What I cannot read in a posting is which part of the work there does not show up in it. Fifteen minutes, or just a reply to this email, would be genuinely useful.

The posting: ${canonicalUrl}

${sender.name}`,
    };
  }

  /**
   * Written against the only part of the cold-email literature that survived verification.
   *
   * A referral is not a forward; it is the referrer spending their own name. The pre-
   * registered RCT across 238 stores found supply rationed by the referrer's willingness to
   * attach it — raising the bonus bought MORE referrals of WORSE quality, and referrers
   * withheld entirely on roles they thought were bad. So what this email owes them is
   * UNDERWRITING MATERIAL, not rapport: the specific requisition, and the two or three
   * concrete things that make them right about you. That is also why the "because" here has
   * to be real — Langer's placebic reason produced compliance identical to no reason at all
   * (.24 vs .24) once the favour took actual effort.
   *
   * It still opens on a prior conversation, and that slot is load-bearing rather than
   * decorative: every measured referral finding concerns someone the referrer already knows,
   * and nothing measured says a stranger referral converts. The draft is unsendable until a
   * conversation exists, which is the structural version of that caveat.
   */
  return {
    subject: `Referral for ${company} — ${shortTitle(title) ?? 'summer internship'}?`,
    body: `${greeting}

Thanks again for ${slot(outline.met, 'the call')} — ${slot(outline.said, 'the specific thing they said')}, and I ended up ${slot(outline.didWith, 'what you did with it')}.

${company} has ${title} open, and I am applying either way. If you are willing to put your name on it, the three things that would make you right about me:

${[
  slot(outline.fit?.[0], 'something you built that maps onto what this team owns'),
  slot(outline.fit?.[1], 'the closest thing you have to their stack or problem'),
  slot(outline.fit?.[2], 'why this specific team, in one line — not why the company'),
]
  .map((line) => `- ${line}`)
  .join('\n')}

If that is not enough to go on off one conversation, a one-word no is a fine answer and I will not ask again.

The posting: ${canonicalUrl}

Resume attached, and I will send whatever else the internal form asks for.

${sender.name}`,
  };
}
