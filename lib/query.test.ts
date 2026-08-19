/**
 * The sort and visibility gate. Every case here is one a plausible implementation gets wrong:
 * an ordering that is not plain recency, Design's location rule leaking onto Engineering or
 * failing to hide anything, a location spelling the rule does not recognize being deleted
 * rather than merely mis-sorted, a tie-break that stops one key short, or a `senior+` row
 * surviving a filter combination.
 *
 * Runs against a real SQLite database with the committed migrations applied, because both the
 * ordering and the location rule are produced by SQL, not by JavaScript.
 */

import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';
import { REFS, fixtures, refKey } from '../scripts/seed.ts';
import type { Db } from './db/index.ts';
import { postings } from './db/schema.ts';
import { GEO_TIER, geoTier } from './geo.ts';
import {
  geoTierSql,
  getPostingDetail,
  listPostings,
  outsideTargetLocations,
  tabIsEmpty,
} from './query.ts';
import {
  DEFAULT_BASIS,
  FILTERS,
  POSTED_WINDOWS,
  TABS,
  WINDOW_MS,
  cleared,
  href,
  parseParams,
  type Params,
  type Tab,
  vocab,
  withBasis,
  withFilter,
} from './params.ts';

const NOW = Date.UTC(2026, 2, 17, 12, 0, 0);

let db: Db;
/** Row id -> fixture ref, so assertions read as the handles the fixtures are named by. */
let refOf: Map<number, string>;

function params(tab: Tab, over: Partial<Params> = {}): Params {
  return {
    tab,
    // Faithful to `parseParams`: Design always lands on a side of the freelance split,
    // Engineering has no split at all.
    basis: tab === 'design' ? DEFAULT_BASIS : null,
    posted: null,
    type: null,
    pay: null,
    mode: null,
    season: null,
    level: null,
    badge: null,
    job: null,
    ...over,
  };
}

async function order(p: Params): Promise<string[]> {
  return (await listPostings(db, p, NOW)).map((row) => refOf.get(row.id)!);
}

async function times(p: Params): Promise<number[]> {
  return (await listPostings(db, p, NOW)).map((row) => row.postedAt.getTime());
}

function idOf(ref: string): number {
  return [...refOf].find(([, r]) => r === ref)![0];
}

function fromUrl(url: string): Params {
  return parseParams(Object.fromEntries(new URL(`http://workie.local${url}`).searchParams));
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
  it.each(TABS)('%s: posted_at descends, with no exceptions', async (tab) => {
    const list = await times(params(tab));
    expect(list.length).toBeGreaterThan(5);
    expect(list).toEqual([...list].sort((a, b) => b - a));
  });

  // All three are employed-side rows, which is the side `params('design')` lands on. The
  // 6h-old `d-unknown-pay` used to be the newest here and is freelance, so it now sits on the
  // other side of the split — see the split's own describe block for the ordering there.
  it('design: three known timestamps come back newest first', async () => {
    const list = await order(params('design'));
    before(list, 'd-remote-mid', 'd-unpaid-intern'); // 9h before 2d
    before(list, 'd-unpaid-intern', 'd-sparse'); // 2d before 21d
  });

  it('engineering: three known timestamps come back newest first', async () => {
    const list = await order(params('engineering'));
    before(list, 'e-voice', 'e-intern-summer'); // 3h before 5h
    before(list, 'e-intern-summer', 'e-sf-3d'); // 5h before 3d
  });

  it.each(TABS)('%s: identical posted_at, entry above mid', async (tab) => {
    before(await order(params(tab)), `${tab[0]}-tie-entry`, `${tab[0]}-tie-mid`);
  });

  /**
   * The page renders the "last 24 hours" band as `rows.slice(0, freshCount)` — a prefix, not a
   * partition. That is only correct while `posted_at desc` is the FIRST sort key, and the
   * explicit fresh-bucket key that used to guarantee it is exactly what this change removed.
   * Put any key ahead of recency and stale rows render under the accent band.
   */
  it.each(TABS)('%s: the fresh rows are a prefix, which is what the band renders', async (tab) => {
    const fresh = (await times(params(tab))).map((t) => NOW - t < WINDOW_MS.day);
    const firstStale = fresh.indexOf(false);
    expect(firstStale, 'the corpus needs both fresh and stale rows to test this').toBeGreaterThan(0);
    expect(fresh.slice(firstStale), 'a fresh row sorted below a stale one').not.toContain(true);
  });
});

describe('design shows the target locations, engineering shows every location', () => {
  it('hides a Berlin posting that Engineering shows, in the same corpus', async () => {
    expect(await order(params('design'))).not.toContain('d-berlin-3d');
    expect(await order(params('engineering'))).toContain('e-berlin-3d');
  });

  it('hides it even when it would otherwise lead the table', async () => {
    // Two hours old against a nine-hour-old survivor: recency does not buy an exemption.
    expect(await order(params('design'))).not.toContain('d-berlin-2h');
    expect((await order(params('design')))[0]).toBe('d-remote-mid');
  });

  it('keeps tier 0, tier 1 and tier 2', async () => {
    const list = await order(params('design'));
    expect(list).toContain('d-sf-3d'); // tier 0, a target metro
    expect(list).toContain('d-oakland-entry'); // tier 1, California outside the metros
    expect(list).toContain('d-remote-mid'); // tier 2, remote
  });

  /**
   * The regression this rule invited: 137 live postings arrive spelled "New York City" or
   * "San Francisco Office". As a sort key the missed alias cost them a few positions; as a
   * visibility rule it would delete them. `normalizeLocation` resolves the spelling now, so
   * these two carry the canonical key — `normalize.test.ts` guards the resolution itself.
   */
  it('keeps target metros that arrived with a board-flavoured spelling', async () => {
    const list = await order(params('design'));
    expect(list).toContain('d-nyc-loose'); // "New York City, New York, United States"
    expect(list).toContain('d-sf-office'); // "San Francisco Office"
  });

  it('keeps a role whose only remote signal is work_mode', async () => {
    // Location says London, is_remote is 0, the body says remote. Remote is a target tier.
    expect(await order(params('design'))).toContain('d-london-remote');
  });

  it('keeps a posting whose location never normalized, rather than dropping it silently', async () => {
    expect(await order(params('design'))).toContain('d-nowhere');
  });

  it('a non-California US city is elsewhere, so Design hides it too', async () => {
    expect(await order(params('design'))).not.toContain('d-austin');
    expect(await order(params('engineering'))).toContain('e-austin');
  });

  it('the rule reads the row, not a list of refs: moving a posting moves it in or out', async () => {
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('d-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('d-berlin-3d'))).run();

    const list = await order(params('design'));
    expect(list).not.toContain('d-sf-3d'); // now in Berlin
    expect(list).toContain('d-berlin-3d'); // now in SF
  });

  it('engineering ignores location entirely: swapping two of them changes nothing', async () => {
    const first = await order(params('engineering'));
    db.update(postings).set(BERLIN).where(eq(postings.id, idOf('e-sf-3d'))).run();
    db.update(postings).set(SF).where(eq(postings.id, idOf('e-berlin-3d'))).run();

    expect(await order(params('engineering'))).toEqual(first);
  });

  /**
   * The hole this class of rule keeps reopening: the table is not the only way in. A Design
   * posting the table refuses to list must not be reachable through `?job=<id>` either, and
   * the same rule has to hold for a track the detail query never sees.
   */
  it('the deep link obeys the location rule, not just the table', async () => {
    expect(await getPostingDetail(db, idOf('d-berlin-3d'), NOW), 'design, elsewhere').toBeNull();
    expect(await getPostingDetail(db, idOf('d-nowhere'), NOW), 'design, unknown').not.toBeNull();
    expect(await getPostingDetail(db, idOf('e-berlin-3d'), NOW), 'engineering, elsewhere').not.toBeNull();
  });

  it('counts what geography hides, so an empty table can say so', async () => {
    // d-berlin-3d, d-berlin-2h, d-austin. Not d-old-berlin, which is elsewhere too but 62
    // days old — a row the tab would not show anyway must not inflate the count.
    expect(await outsideTargetLocations(db, params('design'), NOW)).toBe(3);
  });

  /** The count sits under "no postings match these filters", so it has to be an answer to
   *  that question rather than a fact about the whole tab. */
  it('counts under the same filters it is explaining', async () => {
    expect(await outsideTargetLocations(db, params('design', { mode: 'onsite' }), NOW)).toBe(1);
    expect(await outsideTargetLocations(db, params('design', { mode: 'remote' }), NOW)).toBe(0);
  });
});

describe('SQL geo tier matches lib/geo.ts', () => {
  it('agrees with geoTier() on every fixture', async () => {
    const rows = db
      .select({
        tier: geoTierSql,
        cityNorm: postings.cityNorm,
        state: postings.state,
        country: postings.country,
        isRemote: postings.isRemote,
        workMode: postings.workMode,
      })
      .from(postings)
      .all();

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(Number(row.tier), JSON.stringify(row)).toBe(
        geoTier(
          {
            city_norm: row.cityNorm,
            state: row.state,
            country: row.country,
            is_remote: row.isRemote,
          },
          row.workMode,
        ),
      );
    }
    // Guards against a corpus that only exercises some branches of the CASE.
    expect(new Set(rows.map((r) => Number(r.tier)))).toEqual(
      new Set([GEO_TIER.metro, GEO_TIER.california, GEO_TIER.remote, GEO_TIER.elsewhere, GEO_TIER.unknown]),
    );
  });
});

describe('rows that must never render', () => {
  /** Every single-value setting of every filter, and every filter cleared. */
  function everyFilter(tab: Tab): Params[] {
    const out = [params(tab)];
    for (const filter of FILTERS) {
      for (const value of vocab(tab, filter)) out.push(params(tab, { [filter]: value }));
    }
    out.push(params(tab, { badge: 'voice-ai' }));
    return out;
  }

  it.each(TABS)('%s: no senior+ row under any filter', async (tab) => {
    const combos = everyFilter(tab);
    expect(combos.length).toBeGreaterThan(8);
    for (const p of combos) {
      expect(await order(p), JSON.stringify(p)).not.toContain(`${tab[0]}-senior`);
    }
  });

  it.each(TABS)('%s: nothing older than 60 days', async (tab) => {
    expect(await order(params(tab))).not.toContain(`${tab[0]}-old`);
  });

  it.each(TABS)('%s: nothing delisted', async (tab) => {
    expect(await order(params(tab))).not.toContain(`${tab[0]}-delisted`);
  });

  // The table is not the only way in: `?job=<id>` reaches a posting directly.
  it.each(['senior', 'old', 'delisted'])('the %s posting is not reachable by deep link', async (kind) => {
    for (const tab of ['d', 'e'] as const) {
      const id = idOf(`${tab}-${kind}`);
      expect(await getPostingDetail(db, id, NOW), `${tab}-${kind}`).toBeNull();
    }
  });

  it('a visible posting is reachable by deep link', async () => {
    expect((await getPostingDetail(db, idOf('e-sf-3d'), NOW))?.company).toBe('Northline');
  });

  it('a tab never shows the other track', async () => {
    expect((await order(params('design'))).every((ref) => ref.startsWith('d-'))).toBe(true);
    expect((await order(params('engineering'))).every((ref) => ref.startsWith('e-'))).toBe(true);
  });
});

describe('filters', () => {
  // `d-sparse` rather than `d-unknown-pay`: both have no pay, and this one is on the employed
  // side, so the assertion is about the pay rule and not about which side of the split it is on.
  it('pay unknown matches neither value but stays visible with the filter off (finding G)', async () => {
    expect(await order(params('design'))).toContain('d-sparse');
    expect(await order(params('design', { pay: 'paid' }))).not.toContain('d-sparse');
    expect(await order(params('design', { pay: 'unpaid' }))).not.toContain('d-sparse');
    expect(await order(params('design', { pay: 'unpaid' }))).toContain('d-unpaid-intern');
  });

  /**
   * Was "the junior option covers entry as well (finding F)". Entry has its own option now, so
   * the two are asserted apart: each level option returns its own rows and nothing else. The
   * fold was hiding the larger group (281 entry engineering postings against 13 junior) behind
   * the smaller one's label.
   */
  it.each(['entry', 'junior', 'mid'] as const)('the %s option means exactly that level', async (level) => {
    const list = await order(params('engineering', { level }));
    const others = { entry: ['e-sf-3d', 'e-tie-mid'], junior: ['e-nyc-entry', 'e-tie-mid'], mid: ['e-nyc-entry', 'e-sf-3d'] }[level];
    const own = { entry: 'e-nyc-entry', junior: 'e-sf-3d', mid: 'e-tie-mid' }[level];
    expect(list, `${level} should list its own rows`).toContain(own);
    for (const ref of others) expect(list, `${level} must not list ${ref}`).not.toContain(ref);
  });

  it('posted-within windows narrow monotonically', async () => {
    const count = async (posted: Params['posted']) => (await order(params('engineering', { posted }))).length;
    expect(await count('month')).toBeGreaterThan(await count('week'));
    expect(await count('week')).toBeGreaterThan(await count('day'));
    expect(await count('day')).toBeGreaterThan(await count('hour'));
    expect(await count('hour')).toBe(0);
  });

  it('every dropdown narrows on its own', async () => {
    for (const tab of TABS) {
      const all = (await order(params(tab))).length;
      for (const filter of FILTERS) {
        for (const value of vocab(tab, filter)) {
          const narrowed = await order(params(tab, { [filter]: value }));
          expect(narrowed.length, `${tab} ${filter}=${value}`).toBeLessThan(all);
          expect(await order(params(tab)), `${tab} ${filter}=${value}`).toEqual(
            expect.arrayContaining(narrowed),
          );
        }
      }
    }
  });

  it('filters AND across groups', async () => {
    const remote = await order(params('engineering', { mode: 'remote' }));
    expect(remote).toContain('e-remote-mid');
    expect(remote).toContain('e-intern-winter');

    const narrowed = await order(params('engineering', { mode: 'remote', type: 'internship' }));
    expect(narrowed).toContain('e-intern-winter');
    expect(narrowed).not.toContain('e-remote-mid'); // remote, but full-time
  });

  it('design: the window and a group narrow together', async () => {
    const week = await order(params('design', { posted: 'week' }));
    expect(week).toContain('d-sf-3d'); // 3 days old
    expect(week).not.toContain('d-freelance'); // 11 days old
    expect(await order(params('design', { posted: 'week', type: 'internship' }))).toEqual([
      'd-unpaid-intern',
    ]);
  });

  it('season filters internships', async () => {
    expect(await order(params('engineering', { season: 'summer' }))).toEqual(['e-intern-summer']);
  });

  it('a badge is a filter value', async () => {
    expect(await order(params('engineering', { badge: 'voice-ai' }))).toEqual(['e-voice', 'e-voice-remote']);
    expect(await order(params('engineering', { badge: 'design-systems' }))).toEqual([]);
  });

  it('reports zero results without claiming the tab is empty', async () => {
    const p = params('design', { type: 'part-time', mode: 'remote' });
    expect(await order(p)).toEqual([]);
    expect(await tabIsEmpty(db, p, NOW)).toBe(false);
  });
});

describe('badges and dropdowns write the same filter', () => {
  /**
   * The two controls reach the same param by different routes — a badge renders a link built
   * by `withFilter`, a dropdown submits `<select name={filter}>` with the raw value — so the
   * property that matters is that both land on the same state for every value on offer. Both
   * read their vocabulary from `vocab()`, which is what stops one of them drifting.
   */
  it('every value of every filter arrives the same way from either control', async () => {
    for (const tab of TABS) {
      for (const filter of FILTERS) {
        for (const value of vocab(tab, filter)) {
          const badge = fromUrl(withFilter(params(tab), filter, value));
          const dropdown = parseParams({ tab, [filter]: value });
          expect(badge[filter], `${tab} ${filter}=${value} via badge`).toBe(value);
          expect(dropdown[filter], `${tab} ${filter}=${value} via dropdown`).toBe(value);
          expect(href(badge)).toBe(href(dropdown));
        }
      }
    }
  });

  it('clicking the badge that is already selected clears just that filter', async () => {
    const on = fromUrl(withFilter(params('engineering', { level: 'junior' }), 'mode', 'remote'));
    expect([on.mode, on.level]).toEqual(['remote', 'junior']);

    const off = fromUrl(withFilter(on, 'mode', null));
    expect(off.mode).toBeNull();
    expect(off.level, 'clearing one filter must not clear the others').toBe('junior');
  });

  it('a filter link cannot carry a value the tab does not offer', async () => {
    // Season is Engineering's; `posted` is now shared, so it survives on both tabs.
    expect(withFilter(params('design'), 'season', 'summer')).toBe('/');
    expect(withFilter(params('design'), 'posted', 'hour')).toBe('/?posted=hour');
    expect(withFilter(params('engineering'), 'posted', 'hour')).toBe('/?tab=engineering&posted=hour');
  });

  /** Design offered `week` alone until a one-option dropdown read as a broken control. */
  it.each(TABS)('%s offers every posted window', (tab) => {
    expect(vocab(tab, 'posted')).toEqual([...POSTED_WINDOWS]);
  });

  it('changing a filter closes the drawer rather than carrying it along', async () => {
    expect(withFilter(params('engineering', { job: 12 }), 'mode', 'remote')).not.toContain('job=');
  });
});

/**
 * The Design freelance split. A partition, not a filter: the properties worth pinning are that
 * it loses nothing and duplicates nothing, because either failure is silent — a posting that
 * falls between the sides is simply never seen again, and nothing else in the app would notice.
 */
describe('the Design freelance split', () => {
  const both = async () => [
    await order(params('design', { basis: 'employed' })),
    await order(params('design', { basis: 'freelance' })),
  ];

  it('puts every visible Design posting on exactly one side', async () => {
    const [employed, freelance] = await both();
    const overlap = employed.filter((ref) => freelance.includes(ref));
    expect(overlap, 'a posting on both sides would be double-counted').toEqual([]);
    // The union has to equal what the tab shows with no split applied at all, which is what
    // `basis: null` asks for — a shape only reachable here, never from a URL.
    const whole = await order(params('design', { basis: null }));
    expect([...employed, ...freelance].sort()).toEqual([...whole].sort());
  });

  it('routes freelance and contract to the freelance side', async () => {
    const [employed, freelance] = await both();
    expect(freelance).toContain('d-unknown-pay'); // type: freelance
    expect(freelance).toContain('d-contract'); // type: contract — the case a literal match misses
    expect(freelance).toContain('d-freelance');
    expect(employed).not.toContain('d-contract');
  });

  it('keeps an undetermined employment type on the employed side rather than dropping it', async () => {
    // `d-sparse` has no employment type at all. `NULL not in (...)` is NULL, so without the
    // coalesce in `isEmployed` this row would belong to neither side and vanish from the tab.
    const [employed, freelance] = await both();
    expect(employed).toContain('d-sparse');
    expect(freelance).not.toContain('d-sparse');
  });

  it('sorts each side by the same two keys as the tab', async () => {
    before(await order(params('design', { basis: 'freelance' })), 'd-unknown-pay', 'd-contract'); // 6h before 7h
    before(await order(params('design', { basis: 'freelance' })), 'd-contract', 'd-freelance'); // 7h before 11d
  });

  it('still obeys the location rule and the structural rules on both sides', async () => {
    for (const list of await both()) {
      expect(list).not.toContain('d-berlin-3d'); // elsewhere
      expect(list).not.toContain('d-senior'); // senior+
      expect(list).not.toContain('d-delisted');
      expect(list).not.toContain('d-old'); // past the 60-day cutoff
    }
  });

  it('is a Design control only — Engineering has no side', async () => {
    expect(parseParams({ tab: 'engineering', basis: 'freelance' }).basis).toBeNull();
    expect(parseParams({ tab: 'design' }).basis).toBe(DEFAULT_BASIS);
    expect(parseParams({ tab: 'design', basis: 'nonsense' }).basis).toBe(DEFAULT_BASIS);
  });

  it('writes only the non-default side into the URL', async () => {
    expect(href(params('design', { basis: 'employed' }))).toBe('/');
    expect(href(params('design', { basis: 'freelance' }))).toBe('/?basis=freelance');
    expect(withBasis(params('design'), 'freelance')).toBe('/?basis=freelance');
    expect(withBasis(params('design', { basis: 'freelance' }), 'employed')).toBe('/');
  });

  it('drops a type the destination side does not offer when crossing', async () => {
    // Carrying `type=part-time` onto the freelance side would show an empty table under a
    // control set to a value that side cannot have.
    expect(withBasis(params('design', { type: 'part-time' }), 'freelance')).toBe('/?basis=freelance');
    expect(withBasis(params('design', { type: 'contract', basis: 'freelance' }), 'employed')).toBe('/');
  });

  it('survives clearing the filters — clear is not a way across the split', async () => {
    expect(cleared(params('design', { basis: 'freelance', type: 'contract' }))).toBe('/?basis=freelance');
  });
});

describe('search params are validated, not trusted', () => {
  /**
   * The invariant the filter button rests on. That GET form submits every control, including
   * the ones left on "any", so the page is asked for `?type=&pay=&mode=` constantly. The page
   * used to refuse to render those and `redirect()` to the tidy URL instead, which broke the
   * button outright — `next/form` navigates on the client and a redirect thrown mid-stream
   * leaves an empty tree. Nothing needs the redirect as long as a form-shaped URL parses to
   * exactly what the tidy one parses to, which is what this pins.
   */
  it.each([
    ['design employed', { tab: 'design', basis: 'employed', posted: 'week' }, { posted: 'week' }],
    ['design freelance', { tab: 'design', basis: 'freelance', type: 'contract' }, { basis: 'freelance', type: 'contract' }],
    ['engineering', { tab: 'engineering', posted: 'day', level: 'entry' }, { tab: 'engineering', posted: 'day', level: 'entry' }],
    ['nothing chosen', { tab: 'design', basis: 'employed' }, {}],
  ])('%s: a form submission parses to the same params as the tidy URL', (_label, chosen, tidy) => {
    const empties = { type: '', pay: '', mode: '', season: '', level: '', posted: '' };
    // The form sends every control; the chosen ones overwrite their empty defaults.
    const submitted = parseParams({ ...empties, ...chosen });
    expect(submitted).toEqual(parseParams(tidy));
    // And the URL the page would tidy to is reachable from what was submitted.
    expect(fromUrl(href(submitted))).toEqual(submitted);
  });

  it('drops values outside the tab vocabulary', async () => {
    const p = parseParams({ tab: 'design', posted: 'hour', season: 'summer', type: 'part-time' });
    expect(p.posted).toBe('hour'); // every window is offered on both tabs now
    expect(p.season).toBeNull(); // Design has no seasons
    expect(p.type).toBe('part-time');
  });

  /**
   * The vocabulary a value is checked against depends on the side of the split, so `type` is
   * validated after `basis` is resolved. Both directions matter: a bookmarked
   * `?type=freelance` must not survive onto the employed side and quietly return nothing.
   */
  it('drops a type belonging to the other side of the split', async () => {
    expect(parseParams({ tab: 'design', type: 'freelance' }).type).toBeNull();
    expect(parseParams({ tab: 'design', basis: 'freelance', type: 'freelance' }).type).toBe('freelance');
    expect(parseParams({ tab: 'design', basis: 'freelance', type: 'full-time' }).type).toBeNull();
    expect(parseParams({ tab: 'design', basis: 'freelance', type: 'contract' }).type).toBe('contract');
  });

  it('falls back rather than throwing on junk', async () => {
    const p = parseParams({
      tab: 'marketing',
      level: 'principal,mid',
      pay: ' ',
      job: '-4',
      badge: 'DROP TABLE',
    });
    expect(p.tab).toBe('design');
    expect(p.level).toBe('mid');
    expect(p.pay).toBeNull();
    expect(p.job).toBeNull();
    expect(p.badge).toBeNull();
  });

  /** A URL bookmarked before the filters became dropdowns still parses — to the one value a
   *  dropdown can show, rather than to a filter set the control would misreport. */
  it('takes the first known value from a legacy comma list', async () => {
    expect(parseParams({ tab: 'engineering', mode: 'onsite,remote' }).mode).toBe('onsite');
    expect(parseParams({ tab: 'engineering', mode: 'nonsense,hybrid' }).mode).toBe('hybrid');
  });

  it('round-trips through the URL', async () => {
    const p = parseParams({ tab: 'engineering', mode: 'remote', level: 'junior', job: '12' });
    expect(fromUrl(href(p))).toEqual(p);
  });
});
