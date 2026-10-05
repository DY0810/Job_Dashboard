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

test('design note links the portfolio, not GitHub', () => {
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

test('the proof keeps in-sentence periods and starts at the letter\'s first word', () => {
  const note = outreachDraft({ track: 'engineering', company: 'Acme', role: 'SWE Intern', name: 'DY Lee',
    letter: { ...letter, body: [{ text: 'I built a Node.js service that cut latency by 2.5x for 3,000 users. Then I shipped CI. Third.' }] } });
  assert.equal(note.body.split('\n\n')[0],
    'I recently applied for the SWE Intern role at Acme. I built a Node.js service that cut latency by 2.5x for 3,000 users. Then I shipped CI.');
});

test('a long, unpunctuated body item never pushes the note past 120 words', () => {
  const note = outreachDraft({ track: 'engineering', company: 'Acme', role: 'SWE Intern', name: 'DY Lee', github: 'https://github.com/dy',
    letter: { ...letter, body: [{ text: 'shipped the thing '.repeat(50) }] } });
  assert.ok(words(note.body) <= 120, `${words(note.body)} words`);
  assert.match(note.body, /github\.com\/dy/);
});

test('an empty name leaves no dangling dash in the subject', () => {
  assert.equal(outreachDraft({ track: 'engineering', company: 'Acme', role: 'SWE Intern', name: '' }).subject, 'Applied: SWE Intern');
});
