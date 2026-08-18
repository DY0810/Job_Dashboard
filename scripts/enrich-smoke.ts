/**
 * LIVE model smoke test — `npm run enrich:smoke`. NOT part of `npm test`.
 *
 * `npm test` proves the pipeline (cache, prefilter, spend cap, drops, badges) against a stub:
 * deterministic, offline, no key. It cannot prove that Haiku answers these postings the way
 * a human labeled them, because there is no key in the build environment. This script closes
 * that gap: it makes real calls against a handful of fixtures and prints a field-by-field
 * diff against the hand-authored expectations in `lib/classify.fixtures.ts`.
 *
 *   ANTHROPIC_API_KEY=... npm run enrich:smoke        # the default six
 *   ANTHROPIC_API_KEY=... npm run enrich:smoke -- --all
 *
 * Exits 1 on any mismatch, so it can gate a release once a key exists. It is deliberately
 * kept out of `npm test`: a live model in the unit suite is a flaky suite.
 */

import { pathToFileURL } from 'node:url';

import {
  anthropicClassifier,
  callCostUsd,
  ClassificationSchema,
  CLASSIFY_MODEL,
  MAX_DESCRIPTION_CHARS,
  type Classification,
} from '../lib/classify';
import { GRADED_FIELDS, POSTING_FIXTURES, type ClassifyFixture } from '../lib/classify.fixtures';
import { normalizeDescription } from '../lib/normalize';

/**
 * One of each shape that has bitten a classifier before: a paid internship with a season and
 * a grad year, an unpaid design internship, a new-grad full-time role, a voice-AI role whose
 * title says nothing about voice, a posting that is 80% marketing copy, and an off-track role
 * that must come back as `other`.
 */
const DEFAULT_SMOKE_IDS = [1, 2, 5, 9, 15, 16];

function show(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function diffFixture(fixture: ClassifyFixture, actual: Classification): string[] {
  const mismatches: string[] = [];
  for (const field of GRADED_FIELDS) {
    const expected = fixture.expected[field];
    const got = actual[field];
    if (JSON.stringify(expected) !== JSON.stringify(got)) {
      mismatches.push(`${field.padEnd(18)} expected ${show(expected)}  got ${show(got)}`);
    }
  }
  return mismatches;
}

async function main(): Promise<void> {
  const all = process.argv.includes('--all');
  const fixtures = all
    ? POSTING_FIXTURES
    : POSTING_FIXTURES.filter((fixture) => DEFAULT_SMOKE_IDS.includes(fixture.id));

  console.log(`enrich:smoke — ${fixtures.length} postings against ${CLASSIFY_MODEL}\n`);

  const classify = anthropicClassifier();
  let failures = 0;
  let costUsd = 0;

  for (const fixture of fixtures) {
    const call = await classify({
      title: fixture.title,
      company: fixture.company,
      description: normalizeDescription(fixture.description).slice(0, MAX_DESCRIPTION_CHARS),
    });
    costUsd += callCostUsd(call.inputTokens, call.outputTokens);

    const parsed = ClassificationSchema.safeParse(call.raw);
    if (!parsed.success) {
      failures += 1;
      console.log(`FAIL  ${fixture.company} · ${fixture.title}`);
      console.log(`      response did not match the schema: ${parsed.error.message}\n`);
      continue;
    }

    const mismatches = diffFixture(fixture, parsed.data);
    if (mismatches.length === 0) {
      console.log(`ok    ${fixture.company} · ${fixture.title}`);
      continue;
    }
    failures += 1;
    console.log(`FAIL  ${fixture.company} · ${fixture.title}`);
    for (const line of mismatches) console.log(`      ${line}`);
    console.log('');
  }

  console.log(
    `\n${fixtures.length - failures}/${fixtures.length} matched, est. cost $${costUsd.toFixed(4)}`,
  );
  if (failures > 0) {
    console.log('Mismatches are either a prompt bug or a wrong hand label — check the posting text.');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
