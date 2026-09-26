#!/usr/bin/env node
// Answers open Workie inbox questions from a local answers file, which stays out of this public repo.
//   node scripts/answer-inbox.mjs ~/path/to/answers.json | pbcopy
// then paste into the browser console on the signed-in Workie tab. Anything no rule covers is left for you.
// answers.json: { "owner": "<applicant id>", "rules": [{ "match": "regex on the wording", "tenant"?, "role"?: "regex",
//   "answer": "text" | ["first choice", "/regex/i", ...] }] } — dropdowns take the first preference the form offers.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The first rule matching the question decides; a dropdown gets its first preference that is on offer. */
export function answerFor(question, rules) {
  const wording = question.descriptor.originalWording.toLowerCase().replace(/\s+/g, ' ').trim();
  const field = question.descriptor.field, { tenant, role } = question.application;
  for (const rule of rules) {
    if (!new RegExp(rule.match, 'i').test(wording) || (rule.tenant && rule.tenant !== tenant) ||
        (rule.role && !new RegExp(rule.role, 'i').test(role))) continue;
    const wanted = [rule.answer].flat();
    if (field.type !== 'select') return wanted.find(item => !item.startsWith('/'));
    for (const item of wanted) {
      const slash = item.lastIndexOf('/');
      const pattern = item.startsWith('/') && slash > 0 ? new RegExp(item.slice(1, slash), item.slice(slash + 1)) : null;
      const hit = field.options.find(option => pattern ? pattern.test(option.value) : option.value === item);
      if (hit) return hit.value;
    }
    return undefined; // the rule matched but the form offers none of its answers: leave it for the applicant
  }
}

async function run({ owner, rules }, answerFor) {
  const headers = { 'x-workie-applicant': owner, 'Content-Type': 'application/json' };
  const items = [];
  let cursor = null;
  do {
    const page = await (await fetch('/api/inbox?limit=50' + (cursor ? '&cursor=' + cursor : ''), { cache: 'no-store' })).json();
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < 300);
  const open = [...new Map(items.filter(i => i.question && !i.question.resolved && i.question.canAnswer)
    .map(i => [i.question.id, i.question])).values()];
  // Known answers first, so an application resumes only once every answer it can get is in.
  const plan = open.map(q => ({ q, value: answerFor(q, rules) })).sort((a, b) => (a.value === undefined) - (b.value === undefined));
  const out = [];
  for (const { q, value } of plan) {
    const tag = `${q.application.company} ${q.application.requisition}: ${q.descriptor.originalWording.slice(0, 50)}`;
    if (value === undefined) { out.push(`LEFT FOR YOU  ${tag}`); continue; }
    const d = await (await fetch(`/api/questions/${q.id}`, { headers, cache: 'no-store' })).json();
    const body = { requestId: crypto.randomUUID(), expectedRevision: d.revision, expectedProfileRevision: d.expectedProfileRevision,
      expectedPolicyRevision: d.expectedPolicyRevision, expectedScopeHash: d.expectedScopeHash, factVersions: d.factVersions,
      reuse: 'application', answer: d.descriptor.field.type === 'select' ? { type: 'choice', value } : { type: 'text', value } };
    const r = await fetch(`/api/questions/${q.id}/answer`, { method: 'POST', headers, body: JSON.stringify(body), cache: 'no-store' });
    const ack = await r.json().catch(() => null);
    out.push(`${r.ok ? 'ANSWERED' : 'FAILED ' + r.status}  ${tag} → ${String(value).slice(0, 40)}${ack?.resumedApplicationIds?.length ? ' (resumed)' : ''}`);
  }
  return out.length ? out : ['no open questions'];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/answer-inbox.mjs <answers.json>');
  const answers = JSON.parse(readFileSync(process.argv[2], 'utf8'));
  process.stdout.write(`await (${run.toString()})(${JSON.stringify(answers)}, ${answerFor.toString()})\n`);
}
