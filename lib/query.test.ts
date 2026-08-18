/**
 * The sort and visibility gate. Every case here is one a plausible implementation gets wrong:
 * an ordering that is not plain recency, Design's location filter leaking onto Engineering (or
 * failing to hide anything), a tie-break that stops one key short, or a `senior+` row surviving
 * a filter combination.
 *
 * Runs against a real SQLite database with the committed migrations applied, because both the
 * ordering and the location filter are produced by SQL, not by JavaScript.
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
import { geoTierSql, getPostingDetail, listPostings, tabIsEmpty } from './query.ts';
import {
  GROUPS,
  SHARED_VOCAB,
  VOCAB,
  href,
  parseParams,
  toggle,
  withGroup,
  withPosted,
  type Params,
  type Tab,
} from './params.ts';

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

function times(p: Params): number[] {
  return listPostings(db, p, NOW).map((row) => row.postedAt.getTime());
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

describe('recency first, on both tabs', () => {
  it.each(['design', 'engineering'] as const)('%s: posted_at descends, with no exceptions', (tab) => {
    const list = times(params(tab));
    expect(list.length).toBeGreaterThan(5);
    expect(list).toEqual([...list].sort((a, b) => b - a));
  });

  it('design: three known timestamps come back newest first', () => {
    const list = order(params('design'));
    before(list, 'd-unknown-pay', 'd-unpaid-intern'); // 6h before 2d
    before(list, 'd-unpaid-intern', 'd-sparse'); // 2d before 21d
  });

  it('engineering: three known timestamps come back newest first', () => {
    const list = order(params('engineering'));
    before(list, 'e-voice', 'e-intern-summer'); // 3h before 5h
    before(list, 'e-intern-summer', 'e-sf-3d'); // 5h before 3d
  });

  it.each(['design', 'engineering'] as const)('%s: identical posted_at, entry above mid', (tab) => {
    before(order(params(tab)), `${tab[0]}-tie-entry`, `${tab[0]}-tie-mid`);
  });
});

describe('design excludes GEO_TIER 3, engineering excludes nothing', () => {
  it('the same Berlin posting is hidden on Design and shown on Engineering', () => {
    expect(order(params('design'))).not.toContain('d-berlin-3d');
    expect(order(params('engineering'))).toContain('e-berlin-3d');
  });

  it('tiers 0, 1 and 2 all survive on Design', () => {
    const list = order(params('design'));
    expect(list).toContain('d-sf-3d'); // tier 0, a target metro
    expect(list).toContain('d-oakland-entry'); // tier 1, California outside the metros
    expect(list).toContain('d-remote-mid'); // tier 2, remote
  });

  it('a non-California US city is tier 3, so Design hides it too', () => {
    expect(order(params('design'))).not.toContain('d-austin');
    expect(order(params('engineering'))).toContain('e-austin');
  });

  it('the filter reads the row, not a list of refs: moving a posting moves it in or out', () => {
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('d-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('d-berlin-3d'))).run();

    const list = order(params('design'));
    expect(list).not.toContain('d-sf-3d'); // now in Berlin
    expect(list).toContain('d-berlin-3d'); // now in SF
  });

  it('engineering ignores location entirely: swapping two of them changes nothing', () => {
    const first = order(params('engineering'));
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('e-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('e-berlin-3d'))).run();

    // Same query, same rows, locations exchanged - identical result, unlike Design.
    expect(order(params('engineering'))).toEqual(first);
  });
});

describe('SQL geo tier matches lib/geo.ts', () => {
  it('agrees with geoTier() on every fixture', () => {
    const rows = db
      .select({
        tier: geoTierSql(),
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

  it('design: the window and a group narrow together', () => {
    const week = order(params('design', { posted: 'week' }));
    expect(week).toContain('d-sf-3d'); // 3 days old
    expect(week).not.toContain('d-freelance'); // 11 days old
    expect(order(params('design', { posted: 'week', type: ['internship'] }))).toEqual([
      'd-unpaid-intern',
    ]);
  });

  it('season filters internships', () => {
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

describe('the filter controls write the URL', () => {
  const p = params('engineering');

  function reparse(url: string): Params {
    return parseParams(Object.fromEntries(new URL(`http://workie.local${url}`).searchParams));
  }

  it('what a dropdown writes is what it then shows as selected', () => {
    const chosen = reparse(withGroup(p, 'mode', 'remote'));
    expect(chosen.mode).toEqual(['remote']);
    // The select's value is the href of the option matching the current params, so the option
    // that was chosen is the one that comes back selected.
    expect(withGroup(chosen, 'mode', chosen.mode[0] ?? null)).toBe(withGroup(p, 'mode', 'remote'));
  });

  it('a badge click lands on exactly the URL its dropdown option would', () => {
    expect(toggle(p, 'mode', 'remote')).toBe(withGroup(p, 'mode', 'remote'));
  });

  it('clicking the badge that is already selected clears the group', () => {
    const on = reparse(withGroup(p, 'mode', 'remote'));
    expect(reparse(toggle(on, 'mode', 'remote')).mode).toEqual([]);
  });

  it('"any" clears the group, and clears the window', () => {
    const on = reparse(withPosted(reparse(withGroup(p, 'level', 'junior')), 'day'));
    expect(on.level).toEqual(['junior']);
    expect(on.posted).toBe('day');
    expect(reparse(withGroup(on, 'level', null)).level).toEqual([]);
    expect(reparse(withPosted(on, null)).posted).toBeNull();
  });

  it('filtering closes the drawer rather than carrying it along', () => {
    expect(withGroup({ ...p, job: 12 }, 'mode', 'remote')).not.toContain('job=');
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
