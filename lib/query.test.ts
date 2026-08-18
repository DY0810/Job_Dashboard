/**
 * The sort gate. Every case here is one a plausible implementation gets wrong: the Design
 * tab's four keys in the wrong order, geo weighting leaking onto Engineering, a tie-break
 * that stops one key short, or a `senior+` row surviving a filter combination.
 *
 * Runs against a real SQLite database with the committed migrations applied, because the
 * ordering being asserted is produced by SQL, not by JavaScript.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { REFS, fixtures, refKey } from '../scripts/seed.ts';
import type { Db } from './db/index.ts';
import { postings } from './db/schema.ts';
import { geoTier } from './geo.ts';
import { geoRank, getPostingDetail, listPostings, tabIsEmpty } from './query.ts';
import { GROUPS, SHARED_VOCAB, VOCAB, href, parseParams, type Params, type Tab } from './params.ts';

const NOW = Date.UTC(2026, 2, 17, 12, 0, 0);

let db: Db;
/** Row id -> fixture ref, so assertions read as the handles the fixtures are named by. */
let refOf: Map<number, string>;

function params(tab: Tab, over: Partial<Params> = {}): Params {
  return {
    tab,
    posted: null,
    type: [],
    pay: [],
    mode: [],
    season: [],
    level: [],
    badge: null,
    job: null,
    ...over,
  };
}

function order(p: Params): string[] {
  return listPostings(db, p, NOW).map((row) => refOf.get(row.id)!);
}

function idOf(ref: string): number {
  return [...refOf].find(([, r]) => r === ref)![0];
}

/** Fails loudly on a typo'd ref rather than silently comparing -1 to -1. */
function before(list: string[], a: string, b: string) {
  expect(list, `${a} missing`).toContain(a);
  expect(list, `${b} missing`).toContain(b);
  expect(list.indexOf(a), `${a} should sort above ${b}`).toBeLessThan(list.indexOf(b));
}

const SF = { cityNorm: 'sf', state: 'CA', country: 'US', isRemote: false };
const BERLIN = { cityNorm: 'berlin', state: null, country: 'DE', isRemote: false };

beforeEach(() => {
  db = drizzle(new Database(':memory:')) as unknown as Db;
  migrate(db, { migrationsFolder: 'drizzle' });
  db.insert(postings).values(fixtures(NOW)).run();

  const byKey = new Map(REFS.map((ref) => [refKey(ref), ref]));
  refOf = new Map(
    db
      .select({ id: postings.id, key: postings.dedupeKey })
      .from(postings)
      .all()
      .map((row) => [row.id, byKey.get(row.key)!]),
  );
});

describe('design tab - four sort keys, in order', () => {
  it('key 2: identical postings sort by GEO_TIER, so SF precedes Berlin', () => {
    before(order(params('design')), 'd-sf-3d', 'd-berlin-3d');
  });

  it('key 1 outranks key 2: a 2-hour-old Berlin posting beats a 3-day-old SF one', () => {
    // The case a three-key implementation, geo first, gets wrong.
    before(order(params('design')), 'd-berlin-2h', 'd-sf-3d');
  });

  it('key 4: identical through posted_at, entry sorts above mid', () => {
    before(order(params('design')), 'd-tie-entry', 'd-tie-mid');
  });

  it('geo weighting actually moves rows: swapping two locations flips them', () => {
    before(order(params('design')), 'd-sf-3d', 'd-berlin-3d');
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('d-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('d-berlin-3d'))).run();
    before(order(params('design')), 'd-berlin-3d', 'd-sf-3d');
  });
});

describe('engineering tab - no geo weighting', () => {
  it('an SF and a Berlin posting with identical posted_at keep their order when swapped', () => {
    const first = order(params('engineering'));
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('e-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('e-berlin-3d'))).run();

    // Same query, same rows, locations exchanged - identical ordering, unlike Design.
    expect(order(params('engineering'))).toEqual(first);
  });

  it('key 3: identical through posted_at, entry sorts above mid', () => {
    before(order(params('engineering')), 'e-tie-entry', 'e-tie-mid');
  });

  it('key 1: the 24h band leads, and inside it posted_at descends', () => {
    const list = order(params('engineering'));
    before(list, 'e-voice', 'e-intern-summer'); // 3h before 5h, both fresh
    before(list, 'e-intern-summer', 'e-sf-3d'); // fresh band before everything older
  });
});

describe('SQL geo tier matches lib/geo.ts', () => {
  it('agrees with geoTier() on every fixture', () => {
    const rows = db
      .select({
        tier: geoRank(),
        cityNorm: postings.cityNorm,
        state: postings.state,
        country: postings.country,
        isRemote: postings.isRemote,
      })
      .from(postings)
      .all();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.tier)).toBe(
        geoTier({
          city_norm: row.cityNorm,
          state: row.state,
          country: row.country,
          is_remote: row.isRemote,
        }),
      );
    }
    // Guards against a corpus that only exercises one branch of the CASE.
    expect(new Set(rows.map((r) => Number(r.tier))).size).toBeGreaterThan(2);
  });
});

describe('rows that must never render', () => {
  /** Every single-value setting of every group, every window, every group fully on, cleared. */
  function everyFilter(tab: Tab): Params[] {
    const out = [params(tab)];
    for (const window of VOCAB[tab].posted) {
      out.push(params(tab, { posted: window as Params['posted'] }));
    }
    for (const group of GROUPS) {
      const vocab: readonly string[] =
        group === 'type' || group === 'season' ? VOCAB[tab][group] : SHARED_VOCAB[group];
      for (const value of vocab) out.push(params(tab, { [group]: [value] }));
      if (vocab.length > 1) out.push(params(tab, { [group]: [...vocab] }));
    }
    out.push(params(tab, { badge: 'voice-ai' }));
    return out;
  }

  it.each(['design', 'engineering'] as const)('%s: no senior+ row under any filter', (tab) => {
    const combos = everyFilter(tab);
    expect(combos.length).toBeGreaterThan(8);
    for (const p of combos) {
      expect(order(p), JSON.stringify(p)).not.toContain(`${tab[0]}-senior`);
    }
  });

  it.each(['design', 'engineering'] as const)('%s: nothing older than 60 days', (tab) => {
    expect(order(params(tab))).not.toContain(`${tab[0]}-old`);
  });

  it.each(['design', 'engineering'] as const)('%s: nothing delisted', (tab) => {
    expect(order(params(tab))).not.toContain(`${tab[0]}-delisted`);
  });

  // The table is not the only way in: `?job=<id>` reaches a posting directly.
  it.each(['senior', 'old', 'delisted'])('the %s posting is not reachable by deep link', (kind) => {
    for (const tab of ['d', 'e'] as const) {
      const id = idOf(`${tab}-${kind}`);
      expect(getPostingDetail(db, id, NOW), `${tab}-${kind}`).toBeNull();
    }
  });

  it('a visible posting is reachable by deep link', () => {
    expect(getPostingDetail(db, idOf('e-sf-3d'), NOW)?.company).toBe('Northline');
  });

  it('a tab never shows the other track', () => {
    expect(order(params('design')).every((ref) => ref.startsWith('d-'))).toBe(true);
    expect(order(params('engineering')).every((ref) => ref.startsWith('e-'))).toBe(true);
  });
});

describe('filters', () => {
  it('pay unknown matches neither chip but stays visible with no chip on (finding G)', () => {
    expect(order(params('design'))).toContain('d-unknown-pay');
    expect(order(params('design', { pay: ['paid'] }))).not.toContain('d-unknown-pay');
    expect(order(params('design', { pay: ['unpaid'] }))).not.toContain('d-unknown-pay');
    expect(order(params('design', { pay: ['paid', 'unpaid'] }))).not.toContain('d-unknown-pay');
    expect(order(params('design', { pay: ['unpaid'] }))).toContain('d-unpaid-intern');
  });

  it('the junior chip covers entry as well (finding F)', () => {
    const list = order(params('engineering', { level: ['junior'] }));
    expect(list).toContain('e-nyc-entry'); // entry
    expect(list).toContain('e-sf-3d'); // junior
    expect(list).not.toContain('e-tie-mid'); // mid
  });

  it('posted-within windows narrow monotonically', () => {
    const count = (posted: Params['posted']) => order(params('engineering', { posted })).length;
    expect(count('month')).toBeGreaterThan(count('week'));
    expect(count('week')).toBeGreaterThan(count('day'));
    expect(count('day')).toBeGreaterThan(count('hour'));
    expect(count('hour')).toBe(0);
  });

  it('groups are OR inside and AND across', () => {
    const remote = order(params('engineering', { mode: ['remote'] }));
    const both = order(params('engineering', { mode: ['remote', 'hybrid'] }));
    expect(both.length).toBeGreaterThan(remote.length);

    const narrowed = order(params('engineering', { mode: ['remote'], type: ['internship'] }));
    expect(narrowed).toContain('e-intern-winter');
    expect(narrowed).not.toContain('e-remote-mid'); // remote, but full-time
  });

  it('season chips filter internships', () => {
    expect(order(params('engineering', { season: ['summer'] }))).toEqual(['e-intern-summer']);
  });

  it('a badge is a filter value', () => {
    expect(order(params('engineering', { badge: 'voice-ai' }))).toEqual(['e-voice', 'e-voice-remote']);
    expect(order(params('engineering', { badge: 'design-systems' }))).toEqual([]);
  });

  it('reports zero results without claiming the tab is empty', () => {
    const p = params('design', { type: ['part-time'], mode: ['remote'] });
    expect(order(p)).toEqual([]);
    expect(tabIsEmpty(db, p, NOW)).toBe(false);
  });
});

describe('search params are validated, not trusted', () => {
  it('drops values outside the tab vocabulary', () => {
    const p = parseParams({ tab: 'design', posted: 'hour', season: 'summer', type: 'freelance' });
    expect(p.posted).toBeNull(); // Design offers `week` only
    expect(p.season).toEqual([]); // Design has no season chips
    expect(p.type).toEqual(['freelance']);
  });

  it('falls back rather than throwing on junk', () => {
    const p = parseParams({
      tab: 'marketing',
      level: 'principal,mid',
      pay: ' ',
      job: '-4',
      badge: 'DROP TABLE',
    });
    expect(p.tab).toBe('design');
    expect(p.level).toEqual(['mid']);
    expect(p.pay).toEqual([]);
    expect(p.job).toBeNull();
    expect(p.badge).toBeNull();
  });

  it('round-trips through the URL', () => {
    const p = parseParams({ tab: 'engineering', mode: 'remote,hybrid', level: 'junior', job: '12' });
    const url = new URL(`http://workie.local${href(p)}`);
    expect(parseParams(Object.fromEntries(url.searchParams))).toEqual(p);
  });
});
