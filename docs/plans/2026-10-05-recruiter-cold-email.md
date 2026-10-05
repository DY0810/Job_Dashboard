# Recruiter Cold Email Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or work the checkboxes in order to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each verified submission, Workie finds a verified recruiter address through several sources and sends a short, research-backed note written for the role's track (SWE or design) at a sensible time. When no verified address turns up, it leaves the recipient blank for the applicant.

**Architecture:** This builds on the existing `email_recruiters` pipeline (commit `bf7488c`):
- The worker drafts the note after a receipt and posts it to `/api/worker/applications/[id]/outreach`.
- `lib/applications/outreach.ts` stores the draft, attempts and outcomes in `application_events`, finds a recipient, and sends from the applicant's own Gmail.

This plan:
- replaces the single Hunter lookup with a verified waterfall;
- adds a curated employer domain to the company registry, so the lookup no longer depends on a URL appearing in the posting;
- rewrites the draft per track, following `docs/research/2026-10-05-cold-email-research.md`;
- holds automatic sends until a Tue–Thu morning at least 3 days after the application, released by a Vercel cron.

No database migration is needed. The draft entry gains `sendAfter`, and the event log is schemaless JSON.

**Tech Stack:** Next.js route handlers, Drizzle/libSQL (private DB), zod, vitest (`npm test`), Node 22 `node --test` worker checks (`npm run test:worker`), Hunter.io v2 API, Findymail API (optional), `node:dns/promises`, Vercel Cron.

**Hard rules (do not relax):**
- Never send to an unverified guess. A sendable address is one of:
  - an address the employer published in the posting, whose domain has MX records; or
  - a provider result marked verified on a domain that is not catch-all; or
  - a published generic inbox that Hunter has seen in a live source.
- Never look up by company name. "Sage" resolves to the wrong employer (existing rule in `findRecipient`).
- No pattern guessing, SMTP probing, LinkedIn scraping, or GitHub commit emails. These break the terms of service (GitHub AUP §7, LinkedIn §8.2), fail on catch-all domains, and need outbound port 25, which is usually blocked.
- Hunter HTTP 451 means the person opted out. Skip them and never retry.
- When nothing is found, the outreach stays `status: 'draft', reason: 'no_recipient', to: null`. The Applications page shows an empty To field. This behaviour already exists; keep it under test.
- Automatic sends never retry and never email the same address twice (existing `already_contacted` hold).

---

## File structure

| File | Change | Responsibility |
|---|---|---|
| `lib/applications/outreach.ts` | Modify | Recipient waterfall, send scheduling, due-send sweep |
| `lib/applications/outreach.test.ts` | Modify | Server tests for all of the above |
| `lib/applications/worker-protocol.ts:103-118` | Modify | `source` enum gains `findymail`; `OutreachSchema` gains `sendAfter` |
| `lib/applications/company-domains.ts` | Create | `(ats, tenant) → employer domain` from `scripts/companies.json` |
| `scripts/companies.json` | Modify | Optional `"domain"` per board |
| `scripts/company-domains.ts` | Create | Proposes domains from stored posting text, for human review |
| `lib/applications/application-context-protocol.ts:55-60` | Modify | Context gains `track` |
| `lib/applications/application-context.ts:290-306` | Modify | Fills `track` from `policy.policy.filters.tab` |
| `worker/outreach.ts` | Modify | Track-aware draft, ≤120 words |
| `worker/outreach.check.mjs` | Create | Worker check for the draft |
| `worker/main.ts:373-380` | Modify | Passes `track`, GitHub and portfolio links |
| `app/api/cron/outreach/route.ts` | Create | Cron entry that sends due drafts |
| `vercel.json` | Modify | Cron schedule |
| `app/applications/applications.tsx:69-77` | Modify | Status copy for scheduled drafts |
| `.env.example:102-108`, `docs/auto-apply-workflow.md` | Modify | Document keys and behaviour |

---

### Task 1: Verified recipient waterfall

The order is cheapest and most accurate first. It stops at the first sendable hit:

1. **Posting address.** A recruiting address published in the posting. Sendable only if its domain has MX records.
2. **Hunter, personal.** Domain search with `department=hr`, recruiter-titled people only. Sendable if `verification.status === 'valid'`, or `confidence >= 90` with the domain not `accept_all`.
3. **Findymail.** Domain search by role (optional `WORKIE_FINDYMAIL_API_KEY`). Findymail returns only verified emails.
4. **Hunter, generic.** A recruiting inbox (`university@`, `recruiting@`, …) that Hunter has seen in at least one live source.
5. **Nothing found.** Return `null`; the caller already holds the draft as `no_recipient` with `to: null`.

**Files:**
- Modify: `lib/applications/outreach.ts` (`findRecipient`, `Recipient` type, `OutreachOptions`)
- Modify: `lib/applications/worker-protocol.ts` (`source` enum)
- Test: `lib/applications/outreach.test.ts`

- [ ] **Step 1: Write failing tests.** Add these inside the existing `describe` in `lib/applications/outreach.test.ts`. Add `resolveMx: async () => [{ exchange: 'mx.employer.test', priority: 10 }]` to the `options` object in `beforeEach`, so the existing posting-address test keeps passing.

```ts
  const hunter = (body: object, status = 200) => async () => Response.json(body, { status });
  const person = (extra: object) => ({ value: 'jane.doe@employer.test', first_name: 'Jane', last_name: 'Doe',
    position: 'University Recruiter', confidence: 80, sources: [{ uri: 'https://employer.test/team', still_on_page: true }], ...extra });

  it('skips a posting address whose domain takes no mail', async () => {
    const { token, app } = await application();
    const noMx: OutreachOptions = { ...options, resolveMx: async () => [] };
    expect(await recordOutreachDraft(db, token, app.id, draft({ emails: ['jobs@dead.test'] }), noMx))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null });
    expect(sent).toHaveLength(0);
  });

  it('sends to a Hunter recruiter only when verified, never on a catch-all guess', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    const catchAll = await application();
    options.fetch = hunter({ data: { accept_all: true, emails: [person({ confidence: 95 })] } });
    expect(await recordOutreachDraft(db, catchAll.token, catchAll.app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null });
    const verified = await application();
    options.fetch = hunter({ data: { accept_all: true, emails: [person({ verification: { status: 'valid' } })] } });
    expect(await recordOutreachDraft(db, verified.token, verified.app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'sent', to: 'jane.doe@employer.test', source: 'hunter' });
  });

  it('falls back to Findymail, then a published generic inbox, and treats 451 as an opt-out', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    vi.stubEnv('WORKIE_FINDYMAIL_API_KEY', 'f');
    const calls: string[] = [];
    options.fetch = async (url) => {
      const u = new URL(String(url)); calls.push(`${u.hostname}${u.pathname}?type=${u.searchParams.get('type')}`);
      if (u.hostname === 'app.findymail.com') return Response.json({ contacts: [] });
      if (u.searchParams.get('type') === 'personal') return Response.json({}, { status: 451 });
      return Response.json({ data: { accept_all: false, emails: [
        { value: 'press@employer.test', position: null, confidence: 99, sources: [{ uri: 'https://employer.test' }] },
        { value: 'university@employer.test', position: null, confidence: 90, sources: [{ uri: 'https://employer.test/careers' }] },
      ] } });
    };
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'sent', to: 'university@employer.test', source: 'hunter', name: null });
    expect(calls).toEqual(['api.hunter.io/v2/domain-search?type=personal', 'app.findymail.com/api/search/domain?type=null',
      'api.hunter.io/v2/domain-search?type=generic']);
  });

  it('leaves the recipient blank when every source comes up empty', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    options.fetch = hunter({ data: { accept_all: false, emails: [] } });
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ domains: ['employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'no_recipient', to: null, name: null, source: null });
  });
```

In the existing test `finds a recruiter at the posting domain with Hunter`, wrap the emails as `{ data: { accept_all: true, emails: [...] } }` and add `verification: { status: 'valid' }` to the Jane Doe entry. On a catch-all domain Jane is sendable only because she is verified, so the test now covers the verified path.

- [ ] **Step 2: Run them and confirm they fail.**
Run: `npx vitest run lib/applications/outreach.test.ts`
Expected: the 4 new tests FAIL (no MX check, the catch-all guess gets sent, and Findymail and generic inboxes don't exist yet).

- [ ] **Step 3: Implement the waterfall.** In `lib/applications/outreach.ts`:

```ts
import { resolveMx } from 'node:dns/promises';
```

Change the types:

```ts
type Recipient = { to: string; name: string | null; title: string | null; source: 'posting' | 'hunter' | 'findymail' | 'manual' };
export type OutreachOptions = WorkerOptions & { sender?: OutreachSender; fetch?: typeof fetch; resolveMx?: typeof resolveMx };
```

Replace `HunterSchema` and `findRecipient` with:

```ts
const GENERIC = /^(university|campus|early-?careers?|internships?|recruit(ing|ers?)?|talent|careers?|jobs)([._-]|$)/;
const HunterSchema = z.object({ data: z.object({ accept_all: z.boolean().nullable().optional(), emails: z.array(z.object({
  value: z.string(), first_name: z.string().nullable().optional(), last_name: z.string().nullable().optional(),
  position: z.string().nullable().optional(), confidence: z.number().nullable().optional(),
  verification: z.object({ status: z.string().nullable() }).nullable().optional(),
  sources: z.array(z.unknown()).optional(),
})) }) });
// Confirm this shape against https://app.findymail.com/docs/ before merging; keep only fields used here.
const FindymailSchema = z.object({ contacts: z.array(z.object({
  email: z.string(), name: z.string().nullable().optional(), job_title: z.string().nullable().optional() })) });
const isEmail = (value: string) => z.email().safeParse(value).success;

async function lookup(url: string, init: RequestInit, options: OutreachOptions) {
  try {
    const response = await (options.fetch ?? fetch)(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(5000) });
    return response.ok ? await response.json() : null; // 451 = the person opted out; never retried
  } catch { return null; }
}
const hunter = (domain: string, type: 'personal' | 'generic', key: string, options: OutreachOptions) =>
  lookup(`https://api.hunter.io/v2/domain-search?${new URLSearchParams({ domain, type, limit: '10',
    ...(type === 'personal' ? { department: 'hr' } : {}) })}`, { headers: { 'X-API-KEY': key } }, options)
    .then((body) => HunterSchema.safeParse(body).data?.data ?? null);

/**
 * Verified sources only, cheapest and most accurate first; null leaves the recipient blank for the
 * applicant. Never a company-name lookup ("Sage" alone resolves to the wrong employer) and never a
 * guessed pattern: catch-all domains accept any address, so a guess cannot be verified.
 */
export async function findRecipient(draft: Pick<Draft, 'emails' | 'domains'>, options: OutreachOptions = {}): Promise<Recipient | null> {
  for (const email of draft.emails) {
    const mx = await (options.resolveMx ?? resolveMx)(email.split('@')[1]).catch(() => []);
    if (mx.length) return { to: email, name: null, title: null, source: 'posting' };
  }
  const hunterKey = process.env.WORKIE_HUNTER_API_KEY?.trim(), findymailKey = process.env.WORKIE_FINDYMAIL_API_KEY?.trim();
  for (const domain of draft.domains.slice(0, 2)) {
    const people = hunterKey ? await hunter(domain, 'personal', hunterKey, options) : null;
    const best = people?.emails
      .filter((item) => RECRUITER.test(item.position ?? '') && isEmail(item.value) && item.value.endsWith(`@${domain}`) &&
        (item.verification?.status === 'valid' || (!people.accept_all && (item.confidence ?? 0) >= 90)))
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))[0];
    if (best) return { to: best.value.toLowerCase(), name: [best.first_name, best.last_name].filter(Boolean).join(' ') || null,
      title: best.position ?? null, source: 'hunter' };
    if (findymailKey) {
      const body = await lookup('https://app.findymail.com/api/search/domain', { method: 'POST',
        headers: { authorization: `Bearer ${findymailKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ domain, roles: ['University Recruiter', 'Technical Recruiter', 'Recruiter', 'Talent Acquisition'] }) }, options);
      const hit = FindymailSchema.safeParse(body).data?.contacts.find((item) => isEmail(item.email) && item.email.toLowerCase().endsWith(`@${domain}`));
      if (hit) return { to: hit.email.toLowerCase(), name: hit.name ?? null, title: hit.job_title ?? null, source: 'findymail' };
    }
    const generic = hunterKey ? await hunter(domain, 'generic', hunterKey, options) : null;
    const inbox = generic?.emails.find((item) => isEmail(item.value) && item.value.endsWith(`@${domain}`) &&
      GENERIC.test(item.value.split('@')[0]) && (item.sources?.length ?? 0) > 0);
    if (inbox) return { to: inbox.value.toLowerCase(), name: null, title: null, source: 'hunter' };
  }
  return null;
}
```

In `lib/applications/worker-protocol.ts`, change the `source` line in `OutreachSchema` to:

```ts
  source: z.enum(['posting', 'hunter', 'findymail', 'manual']).nullable(), reason: z.string().nullable(),
```

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npx vitest run lib/applications/outreach.test.ts`
Expected: all PASS. If the Findymail response shape in the docs differs from `FindymailSchema`, fix the schema **and** the mock in the test so both match the documented shape.

- [ ] **Step 5: Typecheck and commit.**
Run: `npx tsc --noEmit -p .`. Expected: no errors.

```bash
git add lib/applications/outreach.ts lib/applications/outreach.test.ts lib/applications/worker-protocol.ts
git commit -m "Send recruiter email only to a verified address, through four sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Employer domain from the company registry

Today `domains` comes only from URLs written in the posting text, and most Greenhouse postings contain none. That means Hunter and Findymail rarely run. A domain checked once by a human per board in `scripts/companies.json` fixes this without falling back to a company-name lookup.

**Files:**
- Create: `lib/applications/company-domains.ts`
- Modify: `lib/applications/outreach.ts` (`recordOutreachDraft`)
- Modify: `scripts/companies.json`
- Create: `scripts/company-domains.ts`
- Test: `lib/applications/outreach.test.ts`

- [ ] **Step 1: Write a failing test.** The fixture tenant is `employer`, so the test injects the registry through options rather than editing `companies.json`:

```ts
  it('looks up the registry domain of the board when the posting names none', async () => {
    vi.stubEnv('WORKIE_HUNTER_API_KEY', 'k');
    const domains: string[] = [];
    options.fetch = async (url) => { domains.push(new URL(String(url)).searchParams.get('domain')!);
      return Response.json({ data: { accept_all: false, emails: [] } }); };
    options.registryDomain = (ats, tenant) => (ats === 'fixture' && tenant === 'employer' ? 'employer.test' : null);
    const { token, app } = await application();
    await recordOutreachDraft(db, token, app.id, draft(), options);
    expect(domains[0]).toBe('employer.test');
  });
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `npx vitest run lib/applications/outreach.test.ts -t "registry domain"`
Expected: FAIL. `domains` is empty because the draft has no domains.

- [ ] **Step 3: Implement.** Create `lib/applications/company-domains.ts`:

```ts
import companies from '../../scripts/companies.json' with { type: 'json' };

const byBoard = new Map((companies as { ats: string; token: string; domain?: string }[])
  .filter((item) => item.domain).map((item) => [`${item.ats}:${item.token}`, item.domain!.toLowerCase()]));

/** The employer's mail domain, checked by a human once per board. Null when not curated. */
export const registryDomain = (ats: string, tenant: string) => byBoard.get(`${ats}:${tenant}`) ?? null;
```

In `lib/applications/outreach.ts`, import it and extend the options type:

```ts
import { registryDomain } from './company-domains.ts';
export type OutreachOptions = WorkerOptions & { sender?: OutreachSender; fetch?: typeof fetch; resolveMx?: typeof resolveMx;
  registryDomain?: typeof registryDomain };
```

Inside `recordOutreachDraft`, where `entry` is built, put the registry domain first:

```ts
    const curated = (options.registryDomain ?? registryDomain)(app.ats, app.tenant);
    const entry: Draft = { outreach: 'draft', company: receipt.company, role: receipt.role, subject: draft.subject,
      body: draft.body, emails: draft.emails, domains: [...new Set([...(curated ? [curated] : []), ...draft.domains])].slice(0, 5) };
```

- [ ] **Step 4: Run it and confirm it passes.**
Run: `npx vitest run lib/applications/outreach.test.ts`. Expected: all PASS.

- [ ] **Step 5: Write the backfill helper, which proposes and never writes on its own.** Create `scripts/company-domains.ts`. For each registry entry without `domain`, it first proposes the `website` already in `scripts/resolve-companies.ts` seeds. Otherwise it reads that board's stored posting descriptions from the public DB (`openDb()`, as `scripts/status.ts` does), counts hosts using `postingContacts` from `worker/outreach.ts`, and prints `name<TAB>ats:token<TAB>top host<TAB>count`. With `--write <file.tsv>`, it applies a TSV the human has edited.

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { postingContacts } from '../worker/outreach.ts';
import { openDb } from '../lib/db/index.ts';
import { SEEDS } from './resolve-companies.ts'; // export the seed array under this name if it is not exported yet
import { postings } from '../lib/db/schema.ts';
import { eq } from 'drizzle-orm';

const path = new URL('./companies.json', import.meta.url);
const companies: { name: string; ats: string; token: string; domain?: string }[] = JSON.parse(readFileSync(path, 'utf8'));
const write = process.argv.indexOf('--write');
if (write > 0) {
  const chosen = new Map(readFileSync(process.argv[write + 1], 'utf8').trim().split('\n').map((line) => {
    const [, board, domain] = line.split('\t'); return [board, domain?.trim()];
  }));
  for (const item of companies) { const domain = chosen.get(`${item.ats}:${item.token}`); if (domain) item.domain = domain; }
  writeFileSync(path, `${JSON.stringify(companies, null, 2)}\n`);
} else {
  const db = openDb();
  const websites = new Map(SEEDS.filter((seed) => seed.website).map((seed) => [seed.name, seed.website!]));
  for (const item of companies.filter((c) => !c.domain)) {
    if (websites.has(item.name)) { console.log([item.name, `${item.ats}:${item.token}`, websites.get(item.name), 'seed'].join('\t')); continue; }
    const rows = await db.select({ d: postings.description }).from(postings).where(eq(postings.company, item.name)).limit(50);
    const counts = new Map<string, number>();
    for (const { d } of rows) for (const host of postingContacts(d ?? '').domains) counts.set(host, (counts.get(host) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1]);
    console.log([item.name, `${item.ats}:${item.token}`, top?.[0] ?? '', top?.[1] ?? 0].join('\t'));
  }
}
```

Run: `node --env-file-if-exists=.env.local scripts/company-domains.ts > /tmp/domains.tsv`. Hand-check every row: open the company's site and confirm the mail domain. Fill in empty rows for target and `design-led` companies. Delete wrong rows. Then run `node scripts/company-domains.ts --write /tmp/domains.tsv`.

- [ ] **Step 6: Commit.**
Run: `npx vitest run scripts lib/applications/outreach.test.ts`. The registry uniqueness and JSON tests must pass.

```bash
git add lib/applications/company-domains.ts lib/applications/outreach.ts lib/applications/outreach.test.ts scripts/company-domains.ts scripts/companies.json
git commit -m "Look up recruiters at each board's curated employer domain

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Research-backed, track-aware draft

Findings from `docs/research/2026-10-05-cold-email-research.md` that this task applies:
- Subject `Applied: <Role> – <Name>`.
- At most 120 words.
- One proof sentence taken from the tailored letter.
- One direct ask, with a "point me to the right person" way out.
- Links: GitHub for engineering, the portfolio deep link for design.
- No "hope this finds you well".
- No pasted company paragraph. Today's draft pastes the whole `companyParagraph` and often runs past 200 words.

**Files:**
- Modify: `lib/applications/application-context-protocol.ts` (`ApplicationContextSchema`)
- Modify: `lib/applications/application-context.ts` (both `ApplicationContextSchema.parse` calls, lines ~290 and ~303)
- Modify: `worker/outreach.ts` (`outreachDraft`)
- Modify: `worker/main.ts:373-380`
- Create: `worker/outreach.check.mjs`

- [ ] **Step 1: Write the failing worker check** in `worker/outreach.check.mjs`:

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outreachDraft } from './outreach.ts';

const letter = { body: [{ text: 'At Hemut I built a voice agent that handles 2,000 carrier calls a week. It cut hold time by 40%. Third sentence.' }],
  companyParagraph: 'A long paragraph about the company. '.repeat(20), introduction: '', conclusion: '' };
const words = (text) => text.split(/\s+/).filter(Boolean).length;

test('engineering note: role subject, one proof, GitHub link, ≤120 words', () => {
  const note = outreachDraft({ track: 'engineering', company: 'Acme', role: 'Software Engineer Intern', name: 'DY Lee',
    github: 'https://github.com/dy', linkedin: 'https://linkedin.com/in/dy', letter });
  assert.equal(note.subject, 'Applied: Software Engineer Intern – DY Lee');
  assert.match(note.body, /2,000 carrier calls/);
  assert.doesNotMatch(note.body, /A long paragraph/);
  assert.match(note.body, /github\.com\/dy/);
  assert.match(note.body, /point me/);
  assert.ok(words(note.body) <= 120, `${words(note.body)} words`);
});

test('design note leads with the portfolio link and stays plain text', () => {
  const note = outreachDraft({ track: 'design', company: 'Acme', role: 'Product Design Intern', name: 'May Hu',
    portfolio: 'https://may.design/acme', letter });
  assert.match(note.body, /Portfolio: https:\/\/may\.design\/acme/);
  assert.doesNotMatch(note.body, /github/i);
  assert.ok(words(note.body) <= 120);
});

test('without a letter it still writes a short, honest note', () => {
  const note = outreachDraft({ track: 'engineering', company: 'Acme', role: 'SWE Intern', name: 'DY Lee' });
  assert.ok(words(note.body) <= 80);
  assert.match(note.body, /SWE Intern role at Acme/);
});
```

- [ ] **Step 2: Run it and confirm it fails.**
Run: `node --test worker/outreach.check.mjs`
Expected: FAIL. The subject is still "Following up on…" and the body includes the company paragraph.

- [ ] **Step 3: Rewrite `outreachDraft`** in `worker/outreach.ts`. Keep `firstSentences` and `postingContacts` as they are.

```ts
type Track = 'engineering' | 'design';

/**
 * The note a recruiter gets a few days after an application (docs/research/2026-10-05-cold-email-research.md):
 * the role in the subject, one proof from the tailored letter, one direct ask, and the work link the
 * track is judged on. Plain text and at most 120 words. The server adds "Hi <name>," once it knows who reads it.
 */
export function outreachDraft(input: { track: Track; company: string; role: string; name: string;
  linkedin?: string; github?: string; portfolio?: string; letter?: Letter }) {
  const proof = input.letter ? firstSentences(input.letter.body[0].text, 2) : '';
  const work = input.track === 'design'
    ? (input.portfolio ? `Portfolio: ${input.portfolio}` : '')
    : (input.github ? `GitHub: ${input.github}` : '');
  return {
    subject: `Applied: ${input.role} – ${input.name}`,
    body: [
      `I recently applied for the ${input.role} role at ${input.company}.${proof ? ` ${proof}` : ''}`,
      ...(work ? [work] : []),
      `I'd appreciate being considered. If someone else handles this role, could you point me to them?`,
      ['Thanks,', input.name, input.linkedin].filter(Boolean).join('\n'),
    ].join('\n\n'),
  };
}
```

If `proof` makes the body exceed 120 words, use `firstSentences(..., 1)`. Add that fallback only if the check fails.

- [ ] **Step 4: Run it and confirm it passes.**
Run: `node --test worker/outreach.check.mjs`. Expected: PASS.

- [ ] **Step 5: Carry the track through the context.** In `lib/applications/application-context-protocol.ts`, next to `outreach`:

```ts
  coverLetterAllowed: z.boolean().default(false), outreach: z.boolean().default(false),
  track: z.enum(['engineering', 'design']).default('engineering'),
```

In `lib/applications/application-context.ts`, add `track: policy.policy.filters.tab,` to **both** `ApplicationContextSchema.parse({...})` calls, next to `outreach:`.

In `worker/main.ts`, replace the `outreachDraft({...})` call at ~line 375:

```ts
        const link = (key: string) => typeof application.answers[key] === 'string' ? application.answers[key] as string : undefined;
        const note = outreachDraft({ track: applicationContext.track, company: applicationContext.company, role: applicationContext.role,
          name: applicant, linkedin: link('linkedin'), github: link('github'), portfolio: link('portfolio'),
          letter: letter ?? await writeLetter().catch(() => undefined) });
```

- [ ] **Step 6: Run everything that touches the context, then commit.**
Run: `npm run test:worker && npx vitest run lib/applications && npx tsc --noEmit -p . && npm run test:e2e`
Expected: all PASS once you update `tests/auto-apply/greenhouse-pipeline.mjs:240-247`, which checks the whole note. Replace both assertions with:

```js
      assert.equal(note.subject, 'Applied: Software Engineering Intern – Test Applicant');
      assert.deepEqual(note.body.split('\n\n'), [
        'I recently applied for the Software Engineering Intern role at Fixture Co. I built TypeScript REST APIs for a scheduling product used by students.',
        "I'd appreciate being considered. If someone else handles this role, could you point me to them?",
        'Thanks,\nTest Applicant\nhttps://linkedin.com/in/test',
      ]);
```

If the fixture sets `answers.github`, a `GitHub: …` paragraph goes second.

```bash
git add worker/outreach.ts worker/outreach.check.mjs worker/main.ts lib/applications/application-context-protocol.ts lib/applications/application-context.ts tests/auto-apply/greenhouse-pipeline.mjs
git commit -m "Write a short recruiter note per track: role subject, one proof, one ask

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Send Tue–Thu morning, at least 3 days after applying

The research says not to email on the day you apply, and to send in a weekday morning in the recipient's time zone. A manual send from the Applications page skips the wait.

**Files:**
- Modify: `lib/applications/outreach.ts` (`Draft`, `fold`, `deliver`, `recordOutreachDraft`, new `sendWindow`, new `sendDueOutreach`)
- Modify: `lib/applications/worker-protocol.ts` (`OutreachSchema.sendAfter`)
- Create: `app/api/cron/outreach/route.ts`
- Modify: `vercel.json`
- Test: `lib/applications/outreach.test.ts`

- [ ] **Step 1: Write failing tests.**

```ts
  it('schedules automatic sends for a Tue–Thu 16:00 UTC at least three days later', () => {
    const mon = Date.UTC(2026, 9, 5, 10); // Monday 2026-10-05 10:00 UTC
    expect(new Date(sendWindow(mon)).toISOString()).toBe('2026-10-08T16:00:00.000Z'); // Thursday
    const thu = Date.UTC(2026, 9, 8, 10);
    expect(new Date(sendWindow(thu)).toISOString()).toBe('2026-10-13T16:00:00.000Z'); // next Tuesday
  });

  it('holds the draft until its window, then the sweep sends it once', async () => {
    options.scheduled = true;
    const { token, app } = await application();
    expect(await recordOutreachDraft(db, token, app.id, draft({ emails: ['jobs@employer.test'] }), options))
      .toMatchObject({ status: 'draft', reason: 'scheduled', to: null, sendAfter: sendWindow(now) });
    expect(sent).toHaveLength(0);
    expect(await sendDueOutreach(db, options)).toBe(0);
    now = sendWindow(now);
    expect(await sendDueOutreach(db, options)).toBe(1);
    expect(await sendDueOutreach(db, options)).toBe(0);
    expect(sent.map((item) => item.to)).toEqual(['jobs@employer.test']);
  });

  it('lets the applicant send a scheduled draft right away', async () => {
    options.scheduled = true;
    const { token, app } = await application();
    await recordOutreachDraft(db, token, app.id, draft(), options);
    expect(await sendOutreach(db, 'alice', app.id, { to: 'pat@employer.test', name: 'Pat' }, options)).toMatchObject({ status: 'sent' });
  });
```

`options.scheduled` defaults to false in tests, so the existing tests that send immediately stay as they are. Production passes `scheduled: true`.

- [ ] **Step 2: Run them and confirm they fail.**
Run: `npx vitest run lib/applications/outreach.test.ts`
Expected: FAIL. `sendWindow` and `sendDueOutreach` are not exported yet.

- [ ] **Step 3: Implement.** In `lib/applications/outreach.ts`:

```ts
type Draft = { outreach: 'draft'; company: string; role: string; subject: string; body: string; emails: string[]; domains: string[];
  sendAfter?: number };
export type OutreachOptions = WorkerOptions & { sender?: OutreachSender; fetch?: typeof fetch; resolveMx?: typeof resolveMx;
  registryDomain?: typeof registryDomain; scheduled?: boolean };

const DAY = 86_400_000;
/** The first Tue–Thu 16:00 UTC (9am Pacific in summer) at least three days after `after`. */
// ponytail: one fixed window for every employer; use the posting's location time zone if replies skew late.
export function sendWindow(after: number) {
  const at = new Date(after + 3 * DAY);
  if (at.getUTCHours() >= 16) at.setUTCDate(at.getUTCDate() + 1);
  at.setUTCHours(16, 0, 0, 0);
  while (![2, 3, 4].includes(at.getUTCDay())) at.setUTCDate(at.getUTCDate() + 1);
  return at.getTime();
}
```

In `fold`, return the schedule when nothing has been attempted yet:

```ts
  if (!latest) return { ...base, status: 'draft', reason: draft.sendAfter && now < draft.sendAfter ? 'scheduled' : null, sentAt: null };
```

Add `sendAfter: draft.sendAfter ?? null` to `base`, and add it to `view`'s destructure and return value.

In `deliver`, right after the existing `if (state.status === 'sent' || …) return view(state);`:

```ts
  if (!manual && state.reason === 'scheduled') return view(state);
```

In `recordOutreachDraft`, spread `...(options.scheduled ? { sendAfter: sendWindow(receipt.submittedAt) } : {})` into `entry`. Don't set `sendAfter: undefined`, because `hashValue` would hash the undefined key.

Add the sweep:

```ts
/** Cron: sends every automatic draft whose window has opened and that nothing has touched yet. */
export async function sendDueOutreach(db: PrivateDb, options: OutreachOptions = {}) {
  const rows = await db.select({ ownerId: applicationEvents.ownerId, applicationId: applicationEvents.applicationId })
    .from(applicationEvents).where(sql`json_extract(${applicationEvents.acknowledgement}, '$.outreach') = 'draft'
      and json_extract(${applicationEvents.acknowledgement}, '$.sendAfter') <= ${nowAt(options)}`);
  let sent = 0;
  for (const { ownerId, applicationId } of rows) {
    const state = fold(applicationId, (await logs(db, ownerId, applicationId)).get(applicationId) ?? [], nowAt(options));
    if (state?.status !== 'draft' || state.attempts > 0 || state.reason) continue; // only untouched, now-due drafts
    if ((await deliver(db, ownerId, applicationId, null, options)).status === 'sent') sent += 1;
  }
  return sent;
}
```

Due drafts with no recipient settle as `no_recipient` on the first sweep. `state.reason` is then set, so later sweeps skip them.

In `lib/applications/worker-protocol.ts`, add `sendAfter: timestamp.nullable(),` to `OutreachSchema`.

- [ ] **Step 4: Run the tests and confirm they pass.**
Run: `npx vitest run lib/applications/outreach.test.ts`. Expected: all PASS.

- [ ] **Step 5: Add the cron route and schedule.** Create `app/api/cron/outreach/route.ts`:

```ts
import { getPrivateDb } from '@/lib/private-db';
import { sendDueOutreach } from '@/lib/applications/outreach';
import { cronGate } from '@/lib/write-gate';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export const maxDuration = 60;

// Same gate as /api/cron/refresh: Vercel Cron's `Authorization: Bearer $CRON_SECRET`.
export async function GET(request: Request) {
  const denied = cronGate(request);
  if (denied) return denied;
  return Response.json({ sent: await sendDueOutreach(getPrivateDb(), { scheduled: true }) });
}
```

`vercel.json`:

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "regions": ["pdx1"],
  "crons": [{ "path": "/api/cron/outreach", "schedule": "10 16 * * 2-4" }]
}
```

In `lib/applications/worker-http.ts`, where the `'outreach'` case builds options for `recordOutreachDraft`, pass `{ ...options, scheduled: true }`.

- [ ] **Step 6: Verify and commit.**
Run: `npx tsc --noEmit -p . && npm run lint && npm run build`. Expected: all succeed.

```bash
git add lib/applications/outreach.ts lib/applications/outreach.test.ts lib/applications/worker-protocol.ts lib/applications/worker-http.ts app/api/cron/outreach/route.ts vercel.json
git commit -m "Hold recruiter email for a Tue–Thu morning three days after applying

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Applications page copy, env, docs

**Files:**
- Modify: `app/applications/applications.tsx:69-77`
- Modify: `.env.example:102-108`
- Modify: `docs/auto-apply-workflow.md`

- [ ] **Step 1: Status copy.** In `outreachStatus`, before the final `return`:

```ts
  if (item.reason === 'scheduled' && item.sendAfter) return `Scheduled for ${new Date(item.sendAfter).toLocaleString()}${item.to ? '' : ' (recipient found at send time)'}. Send now to skip the wait.`;
```

In `OutreachPanel`, the To input already starts as `item.to ?? ''`, so a missing recipient shows as blank. No change is needed there.

- [ ] **Step 2: Env docs.** Replace the `.env.example` recruiter block with:

```
# Recruiter email after a submitted application (policy action `email_recruiters`). It sends from
# the WORKIE_GMAIL_USER account whose address matches the applicant's own, never another one.
# Automatic sends wait for a Tue–Thu 16:00 UTC at least three days after the application
# (Vercel Cron → /api/cron/outreach, authorized by CRON_SECRET).
# Recipients, verified only: a recruiting address in the posting (with MX) → Hunter recruiters at
# the board's curated domain (scripts/companies.json `domain`) or a posting domain → Findymail → a
# published recruiting inbox. Never a company-name lookup or a guessed address; none found = blank.
WORKIE_HUNTER_API_KEY=
WORKIE_FINDYMAIL_API_KEY=
CRON_SECRET=
```

- [ ] **Step 3: Workflow doc.** Add a "Recruiter email" section to `docs/auto-apply-workflow.md` that links `docs/research/2026-10-05-cold-email-research.md` and lists the waterfall, the send window and the blank-recipient behaviour (same content as above, 5–8 lines).

- [ ] **Step 4: Verify in the browser.** Start the dev server with `preview_start`, open `/applications` as DY, and confirm that a scheduled draft shows its time and that a draft with no recipient shows an empty To field. Take a screenshot.

- [ ] **Step 5: Commit.**

```bash
git add app/applications/applications.tsx .env.example docs/auto-apply-workflow.md
git commit -m "Show scheduled recruiter email and document the recipient sources

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

## Rollout (needs DY, not code)

- [ ] Set `CRON_SECRET` and, optionally, `WORKIE_FINDYMAIL_API_KEY` in Vercel production. `WORKIE_HUNTER_API_KEY` is already documented; confirm it is set. The free tier is 50 credits a month. Each application uses up to 4 searches (2 domains × personal and generic), so the free tier covers about 12 applications a month. Hunter Starter ($34–49/mo, 2,000 credits) is the first upgrade.
- [ ] Turn on `email_recruiters` in DY's policy only after Tasks 1–4 are deployed. **May stays off** until May's own Gmail sender and ledger exist (see `applied-ledger` memory).
- [ ] Watch the first five sends on the Applications page before leaving it running.

## Deliberately skipped

- **Follow-up email (1 more after 5–7 days).** Research ranks this as the biggest lever. It needs reply detection (Gmail API or IMAP) and threading headers (`Message-ID`/`In-Reply-To`), and `lib/send.ts` `Outgoing` has neither. Add it as its own plan once Task 4's schedule is live.
- **Résumé PDF attachment.** `Outgoing` has no attachments, and the recruiter already has the résumé through the ATS. Add it when the follow-up plan touches `lib/send.ts`.
- **Apollo and Prospeo.** These would overlap with Hunter and Findymail. Add them only if the logs show more than half of drafts ending `no_recipient` after Task 2's domains are curated.
- **Pattern guessing, SMTP verification, LinkedIn or GitHub sourcing.** These break the hard rules above.
- **Portfolio password in the design note.** The research calls a missing password an automatic pass, but the profile has no password fact. If a portfolio is ever locked, add a `portfolioPassword` identity fact and print `Portfolio: <url> (password: X)`. Until then, keep the portfolio public.
- **Emails to hiring managers or engineers.** The research says to keep that outreach small and personal. It stays manual.
