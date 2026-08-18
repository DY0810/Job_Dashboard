/**
 * `runEnrich` against a real (in-memory) database. This is what proves the row writes and
 * the drop gate — that a dropped posting keeps its row and stores no track, which is what
 * makes it unreachable from either tab.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { eq, isNotNull } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { describe, expect, it } from 'vitest';

import * as schema from '../lib/db/schema.ts';
import { POSTING_FIXTURES, SENIOR_FIXTURES } from '../lib/extract.fixtures.ts';
import type { SourceFields } from '../lib/extract.ts';
import { formatStats, runEnrich, type WorkieDatabase } from './enrich.ts';

const { postings } = schema;

function testDatabase(): WorkieDatabase {
  const sqlite = new Database(':memory:');
  const migrations = fileURLToPath(new URL('../drizzle/', import.meta.url));
  for (const file of readdirSync(migrations).filter((name) => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(join(migrations, file), 'utf8').replaceAll('--> statement-breakpoint', ''));
  }
  return drizzle(sqlite, { schema });
}

function insertPosting(
  db: WorkieDatabase,
  posting: {
    id: number;
    title: string;
    company: string;
    description: string | null;
    sourceFields?: SourceFields;
  },
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
      sourceFields: posting.sourceFields,
      companyNorm: posting.company.toLowerCase(),
      titleNorm: posting.title.toLowerCase(),
      locationKey: 'remote',
    })
    .run();
}

describe('runEnrich', () => {
  it('writes an extraction, and stores nothing for a dropped posting', () => {
    const db = testDatabase();
    const intern = POSTING_FIXTURES[0];
    insertPosting(db, intern);
    insertPosting(db, SENIOR_FIXTURES[0]);

    const stats = runEnrich(db);
    expect(stats.processed).toBe(2);
    expect(stats.stored).toBe(1);
    expect(stats.dropped).toBe(1);
    expect(stats.seniorDrops).toBe(1);

    const kept = db.select().from(postings).where(eq(postings.id, intern.id)).get()!;
    expect(kept.track).toBe('engineering');
    expect(kept.seniority).toBe('entry');
    expect(kept.employmentType).toBe('internship');
    expect(kept.enrichedAt).not.toBeNull();

    // The row survives — `posting_sources` and the ghost pass still need it — but a NULL
    // track is unselectable by either tab, so it is unreachable from the UI.
    const dropped = db.select().from(postings).where(eq(postings.id, SENIOR_FIXTURES[0].id)).get()!;
    expect(dropped.track).toBeNull();
    expect(dropped.seniority).toBeNull();
    expect(dropped.enrichedAt).not.toBeNull();
  });

  it('re-runs over every posting, so a rule change reaches rows already enriched', () => {
    const db = testDatabase();
    insertPosting(db, POSTING_FIXTURES[0]);
    runEnrich(db);

    // Simulate a stale row from an older rule set. A pass that skipped enriched rows would
    // leave this forever; there is no cache and no hash, so the second pass overwrites it.
    db.update(postings).set({ seniority: 'mid' }).where(eq(postings.id, POSTING_FIXTURES[0].id)).run();

    const stats = runEnrich(db);
    expect(stats.processed).toBe(1);
    expect(db.select().from(postings).get()!.seniority).toBe('entry');
  });

  it('classifies a posting with no description from its title alone', () => {
    const db = testDatabase();
    insertPosting(db, { id: 1, title: 'Product Design Intern', company: 'Acme', description: null });

    const stats = runEnrich(db);
    expect(stats.titleOnly).toBe(1);
    expect(stats.stored).toBe(1);
    const row = db.select().from(postings).get()!;
    expect(row.track).toBe('design');
    expect(row.seniority).toBe('entry');
  });

  it('reads the structured fields the connector preserved, not the prose', () => {
    const db = testDatabase();
    insertPosting(db, {
      id: 1,
      title: 'Member of Technical Staff',
      company: 'Acme',
      // The body says hybrid and contract; the source said otherwise and the source wins.
      description: 'We work hybrid. This is a contract role.',
      sourceFields: {
        employmentType: 'full-time',
        workMode: 'remote',
        location: 'Austin, Texas, United States',
        department: 'Software Engineering',
      },
    });

    runEnrich(db);
    const row = db.select().from(postings).get()!;
    expect(row.employmentType).toBe('full-time');
    expect(row.workMode).toBe('remote');
    expect(row.location).toBe('Austin, Texas, United States');
    expect(row.track).toBe('engineering');
  });

  it('drops every senior fixture and keeps every listed one, over the whole set', () => {
    const db = testDatabase();
    for (const fixture of [...POSTING_FIXTURES, ...SENIOR_FIXTURES]) insertPosting(db, fixture);

    runEnrich(db);
    const stored = db.select().from(postings).where(isNotNull(postings.track)).all();
    const storedIds = new Set(stored.map((row) => row.id));

    // Zero leaks: this is the acceptance criterion, and there is no model behind it now.
    for (const senior of SENIOR_FIXTURES) expect(storedIds.has(senior.id)).toBe(false);
    for (const row of stored) expect(row.seniority).not.toBe('senior+');
  });

  it('formats a run summary', () => {
    const line = formatStats({
      processed: 10,
      stored: 6,
      dropped: 4,
      seniorDrops: 3,
      trackDrops: 1,
      titleOnly: 2,
      durationMs: 1500,
    });
    expect(line).toContain('10 processed');
    expect(line).toContain('6 stored');
    expect(line).toContain('4 dropped (3 senior, 1 off-track)');
    expect(line).toContain('1.5s');
  });
});
