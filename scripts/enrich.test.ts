/**
 * `runEnrich` against a real (in-memory) database and a stub client. This is what proves the
 * row writes, the cache table, and that a capped run returns cleanly instead of throwing.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import type { ClassifyClient, ClassifyInput } from '../lib/classify';
import { POSTING_FIXTURES, SENIOR_FIXTURES } from '../lib/classify.fixtures';
import * as schema from '../lib/db/schema';
import { formatStats, runEnrich, type WorkyDatabase } from './enrich';

const { enrichmentCache, postings } = schema;

function testDatabase(): WorkyDatabase {
  const sqlite = new Database(':memory:');
  const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migrations, file), 'utf8').replaceAll('--> statement-breakpoint', ''));
  }
  return drizzle(sqlite, { schema });
}

function insertPosting(
  db: WorkyDatabase,
  posting: { id: number; title: string; company: string; description: string },
): void {
  db.insert(postings)
    .values({
      id: posting.id,
      dedupeKey: `key-${posting.id}`,
      canonicalUrl: `https://example.test/${posting.id}`,
      postedAt: new Date('2026-08-01T00:00:00Z'),
      firstSeenRun: 'run-1',
      company: posting.company,
      title: posting.title,
      description: posting.description,
      companyNorm: posting.company.toLowerCase(),
      titleNorm: posting.title.toLowerCase(),
      locationKey: 'remote',
    })
    .run();
}

function stubClient(tokens = { inputTokens: 0, outputTokens: 0 }): {
  client: ClassifyClient;
  calls: ClassifyInput[];
} {
  const expectedByTitle = new Map(POSTING_FIXTURES.map((f) => [f.title, f.expected]));
  const calls: ClassifyInput[] = [];
  const client: ClassifyClient = async (input) => {
    calls.push(input);
    const expected = expectedByTitle.get(input.title);
    if (!expected) throw new Error(`no hand-authored label for: ${input.title}`);
    return { raw: expected, ...tokens };
  };
  return { client, calls };
}

/** A voice-AI engineering role, an unpaid design internship, an off-track role, a senior one. */
const VOICE = POSTING_FIXTURES[8];
const UNPAID_DESIGN = POSTING_FIXTURES[1];
const OFF_TRACK = POSTING_FIXTURES[15];
const SENIOR = SENIOR_FIXTURES[0];

describe('runEnrich', () => {
  it('writes classifications, and stores nothing for a dropped posting', async () => {
    const db = testDatabase();
    for (const fixture of [VOICE, UNPAID_DESIGN, OFF_TRACK]) insertPosting(db, fixture);
    insertPosting(db, { ...SENIOR, description: SENIOR.description });

    const stub = stubClient();
    const stats = await runEnrich(db, stub.client, { spendCapUsd: 1 });

    expect(stats.stored).toBe(2);
    expect(stats.prefilterDrops).toBe(1);
    expect(stub.calls.map((call) => call.title)).not.toContain(SENIOR.title);

    const voice = db.select().from(postings).where(eq(postings.id, VOICE.id)).get();
    expect(voice?.track).toBe('engineering');
    expect(voice?.seniority).toBe('mid');
    expect(voice?.badges).toContain('voice-ai');
    expect(voice?.summary).not.toBeNull();
    expect(voice?.descriptionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(voice?.enrichedAt).toBeInstanceOf(Date);

    const design = db.select().from(postings).where(eq(postings.id, UNPAID_DESIGN.id)).get();
    expect(design?.track).toBe('design');
    expect(design?.paid).toBe(false);
    expect(design?.internshipSeason).toBe('fall');
    // Engineering-only field, never generated for design.
    expect(design?.summary).toBeNull();

    for (const id of [OFF_TRACK.id, SENIOR.id]) {
      const dropped = db.select().from(postings).where(eq(postings.id, id)).get();
      expect(dropped?.enrichedAt, 'a dropped posting is marked so it is not retried').toBeInstanceOf(Date);
      expect(dropped?.track, 'a NULL track is unreachable from either tab').toBeNull();
      expect(dropped?.badges).toBeNull();
    }
  });

  it('re-enriches from the cache without calling the model', async () => {
    const db = testDatabase();
    insertPosting(db, VOICE);

    const first = stubClient();
    await runEnrich(db, first.client);
    expect(first.calls).toHaveLength(1);
    expect(db.select().from(enrichmentCache).all()).toHaveLength(1);

    // Pretend the posting was re-ingested: same body, enrichment forgotten.
    db.update(postings).set({ enrichedAt: null, track: null }).where(eq(postings.id, VOICE.id)).run();

    const second = stubClient();
    const stats = await runEnrich(db, second.client);

    expect(second.calls).toHaveLength(0);
    expect(stats.cacheHits).toBe(1);
    expect(stats.costUsd).toBe(0);
    expect(db.select().from(postings).where(eq(postings.id, VOICE.id)).get()?.track).toBe('engineering');
  });

  it('re-enriches a posting whose description changed', async () => {
    const db = testDatabase();
    insertPosting(db, VOICE);

    const first = stubClient();
    await runEnrich(db, first.client);
    expect(first.calls).toHaveLength(1);

    // Same posting, edited body: the stored description_hash no longer matches, so it is
    // pending again — and a new body is genuinely a new classification, not a cache hit.
    db.update(postings)
      .set({ description: `${VOICE.description} We also run our own TTS.` })
      .where(eq(postings.id, VOICE.id))
      .run();

    const second = stubClient();
    const stats = await runEnrich(db, second.client);
    expect(second.calls).toHaveLength(1);
    expect(stats.calls).toBe(1);
    expect(db.select().from(enrichmentCache).all()).toHaveLength(2);
  });

  it('leaves a malformed answer un-enriched so the next run retries it', async () => {
    const db = testDatabase();
    insertPosting(db, VOICE);

    const broken: ClassifyClient = async () => ({
      raw: { track: 'engineering' },
      inputTokens: 0,
      outputTokens: 0,
    });
    await runEnrich(db, broken);

    const row = db.select().from(postings).where(eq(postings.id, VOICE.id)).get();
    expect(row?.enrichedAt).toBeNull();
    expect(db.select().from(enrichmentCache).all()).toHaveLength(0);

    const retry = stubClient();
    await runEnrich(db, retry.client);
    expect(retry.calls).toHaveLength(1);
    expect(db.select().from(postings).where(eq(postings.id, VOICE.id)).get()?.track).toBe('engineering');
  });

  it('stops cleanly at the spend cap and leaves the rest for the next run', async () => {
    const db = testDatabase();
    POSTING_FIXTURES.slice(0, 3).forEach((fixture) => insertPosting(db, fixture));

    const stub = stubClient({ inputTokens: 1_000_000, outputTokens: 0 }); // $1.00 per call
    const stats = await runEnrich(db, stub.client, { spendCapUsd: 1 });

    expect(stats.calls).toBe(1);
    expect(stats.capReached).toBe(true);
    expect(stats.remaining).toBe(2);
    expect(formatStats(stats, 1)).toContain('2 postings left for the next run');

    const untouched = db.select().from(postings).where(eq(postings.id, POSTING_FIXTURES[2].id)).get();
    expect(untouched?.enrichedAt).toBeNull();
  });
});
