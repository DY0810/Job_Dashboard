/**
 * The pass is destructive, so the tests are mostly about what it must REFUSE to do. The
 * dangerous mistake is not failing to merge a duplicate; it is merging two real openings.
 */

import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';

import { openDb, type Db } from '../lib/db/index.ts';
import { postings, postingSources } from '../lib/db/schema.ts';
import { findDuplicateGroups, orphanedPostings, runMerge } from './merge-duplicates.ts';

const NOW = Date.UTC(2026, 7, 20);

function db(): Db {
  return openDb(':memory:', { migrate: true });
}

interface Options {
  key: string;
  company?: string;
  title?: string;
  titleNorm?: string;
  locationKey?: string;
  delisted?: boolean;
  postedAt?: number;
  description?: string | null;
  enriched?: boolean;
  urls?: string[];
}

/** One posting plus its sources. Only the columns this pass reads are worth spelling out. */
function insert(database: Db, options: Options): number {
  const id = database
    .insert(postings)
    .values({
      dedupeKey: options.key,
      canonicalUrl: `https://example.test/${options.key}`,
      postedAt: new Date(options.postedAt ?? NOW),
      firstSeenRun: 'run-1',
      company: options.company ?? 'Acme',
      title: options.title ?? 'Software Engineer',
      companyNorm: (options.company ?? 'Acme').toLowerCase(),
      titleNorm: options.titleNorm ?? (options.title ?? 'Software Engineer').toLowerCase(),
      locationKey: options.locationKey ?? 'onsite|sf|CA|US',
      isRemote: false,
      delistedAt: options.delisted ? new Date(NOW) : null,
      enrichedAt: options.enriched ? new Date(NOW) : null,
      description: options.description ?? null,
    })
    .returning({ id: postings.id })
    .get().id;

  for (const url of options.urls ?? [`https://example.test/${options.key}/source`]) {
    database
      .insert(postingSources)
      .values({
        postingId: id,
        source: 'greenhouse',
        sourceUrl: url,
        postedAt: new Date(options.postedAt ?? NOW),
        sourcePriority: 0,
        lastSeenRun: 'run-1',
      })
      .run();
  }
  return id;
}

describe('merge:duplicates', () => {
  it('merges two rows that agree on all three dedupe_key components', () => {
    const database = db();
    const keep = insert(database, { key: 'a' });
    const drop = insert(database, { key: 'b' });

    const stats = runMerge(database, {});

    expect(stats.groups).toBe(1);
    expect(stats.merged).toBe(1);
    expect(database.select().from(postings).all().map((row) => row.id)).toEqual([keep]);
    expect(drop).not.toBe(keep);
  });

  /**
   * The case that makes a fuzzy version of this pass dangerous. Sierra really does list
   * "Enterprise Sales Engineer" in San Francisco and in Sydney; `location_key` is a
   * `dedupe_key` component so that they stay two rows, and merging them would delete an
   * opening someone could have applied to.
   */
  it('refuses to merge the same title in a different location', () => {
    const database = db();
    insert(database, { key: 'a', company: 'Sierra', title: 'Enterprise Sales Engineer', locationKey: 'onsite|sf|CA|US' });
    insert(database, { key: 'b', company: 'Sierra', title: 'Enterprise Sales Engineer', locationKey: 'onsite|sydney||AU' });

    expect(findDuplicateGroups(database)).toEqual([]);
    expect(runMerge(database, {}).merged).toBe(0);
    expect(database.select().from(postings).all()).toHaveLength(2);
  });

  it('refuses to merge a different title in the same location', () => {
    const database = db();
    insert(database, { key: 'a', title: 'Frontend Engineer', titleNorm: 'frontend engineer' });
    insert(database, { key: 'b', title: 'Backend Engineer', titleNorm: 'backend engineer' });

    expect(runMerge(database, {}).merged).toBe(0);
    expect(database.select().from(postings).all()).toHaveLength(2);
  });

  it('keeps the live row and deletes the delisted one, whatever the id order', () => {
    const database = db();
    const delisted = insert(database, { key: 'a', delisted: true, urls: ['https://x.test/1'] });
    const live = insert(database, { key: 'b', urls: ['https://x.test/2'] });

    runMerge(database, {});

    const left = database.select().from(postings).all();
    expect(left).toHaveLength(1);
    expect(left[0].id).toBe(live);
    expect(left[0].id).not.toBe(delisted);
    expect(left[0].delistedAt).toBeNull();
  });

  it('moves the sources across and drops one the survivor already holds', () => {
    const database = db();
    const keep = insert(database, { key: 'a', urls: ['https://x.test/shared', 'https://x.test/only-keep'] });
    insert(database, { key: 'b', delisted: true, urls: ['https://x.test/shared', 'https://x.test/only-drop'] });

    const stats = runMerge(database, {});

    expect(stats.sourcesMoved).toBe(1);
    expect(stats.sourcesAlreadyHeld).toBe(1);
    const urls = database
      .select({ url: postingSources.sourceUrl })
      .from(postingSources)
      .where(eq(postingSources.postingId, keep))
      .all()
      .map((row) => row.url)
      .sort();
    expect(urls).toEqual(['https://x.test/only-drop', 'https://x.test/only-keep', 'https://x.test/shared']);
    // Nothing may be left pointing at a row that no longer exists.
    expect(database.select().from(postingSources).all()).toHaveLength(3);
  });

  it('takes what the survivor lacks instead of losing it', () => {
    const database = db();
    const older = NOW - 10 * 24 * 60 * 60 * 1000;
    // The survivor is chosen for being live, and it is the one missing a description.
    insert(database, { key: 'a', delisted: true, postedAt: older, description: 'the long body', enriched: true });
    const keep = insert(database, { key: 'b', postedAt: NOW, description: null });

    runMerge(database, {});

    const row = database.select().from(postings).where(eq(postings.id, keep)).get()!;
    expect(row.description).toBe('the long body');
    // Floored at the earliest sighting, the same direction ingest moves it.
    expect(row.postedAt.getTime()).toBe(older);
    expect(row.enrichedAt).not.toBeNull();
  });

  it('does not overwrite a field the survivor already has', () => {
    const database = db();
    insert(database, { key: 'a', delisted: true, description: 'stale copy' });
    const keep = insert(database, { key: 'b', description: 'the real body' });

    runMerge(database, {});

    expect(database.select().from(postings).where(eq(postings.id, keep)).get()!.description).toBe('the real body');
  });

  it('leaves no live posting without a source', () => {
    const database = db();
    insert(database, { key: 'a', urls: ['https://x.test/1'] });
    insert(database, { key: 'b', urls: ['https://x.test/2'] });
    insert(database, { key: 'c', locationKey: 'remote', urls: ['https://x.test/3'] });

    expect(orphanedPostings(database)).toBe(0);
    runMerge(database, {});
    expect(orphanedPostings(database)).toBe(0);
  });

  it('a dry run reports the same groups and writes nothing', () => {
    const database = db();
    insert(database, { key: 'a' });
    insert(database, { key: 'b' });

    const stats = runMerge(database, { dryRun: true });

    expect(stats.groups).toBe(1);
    expect(stats.merged).toBe(1);
    expect(database.select().from(postings).all()).toHaveLength(2);
    expect(stats.sourcesMoved).toBe(0);
  });

  it('collapses a group of more than two to a single row', () => {
    const database = db();
    insert(database, { key: 'a', delisted: true });
    const keep = insert(database, { key: 'b', urls: ['https://x.test/1', 'https://x.test/2'] });
    insert(database, { key: 'c', delisted: true });

    const stats = runMerge(database, {});

    expect(stats.merged).toBe(2);
    expect(database.select().from(postings).all().map((row) => row.id)).toEqual([keep]);
  });
});
