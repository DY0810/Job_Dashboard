import { sha256 } from './hash.ts';
import {
  normalizeCompany,
  normalizeLocation,
  normalizeTitle,
  type NormalizedLocation,
} from './normalize.ts';

export type SourceKind = 'ats' | 'aggregator' | 'rss' | 'scrape' | 'repo';

/** 1 ATS direct · 2 aggregator API · 3 RSS · 4 scraped board · 5 GitHub repo. Lower wins. */
export const SOURCE_PRIORITY: Record<SourceKind, number> = {
  ats: 1,
  aggregator: 2,
  rss: 3,
  scrape: 4,
  repo: 5,
};

export interface RawPosting {
  /** Connector name, e.g. `greenhouse`, `remoteok`. */
  source: string;
  sourceKind: SourceKind;
  sourceUrl: string;
  /** Stable job/requisition id in this publisher's own namespace, when available. */
  publisherId?: string | number;
  /**
   * The application form itself, when this source publishes one distinct from the posting
   * page (Ashby's applyUrl, Lever's /apply). Optional: sourceUrl stays the stable identity
   * ghost detection counts absences against; this only redirects the apply button.
   */
  applyUrl?: string;
  /** Epoch ms as reported by THIS source. Never overwritten by the merge. */
  postedAt: number;
  company: string | null | undefined;
  title: string | null | undefined;
  location: string | null | undefined;
}

export interface PostingSource {
  source: string;
  sourceKind: SourceKind;
  sourceUrl: string;
  publisherId?: string;
  applyUrl?: string;
  sourcePriority: number;
  postedAt: number;
}

export interface DedupedPosting {
  /**
   * The normalized triple, additionally namespaced by the winning ATS publisher identity when
   * one exists. Distinct requisitions can therefore coexist under the schema's unique key.
   */
  dedupeKey: string;
  companyNorm: string;
  titleNorm: string;
  locationKey: string;
  location: NormalizedLocation;
  canonicalUrl: string;
  postedAt: number;
  sources: PostingSource[];
}

/** Same company + location, titles this close → one posting. */
export const NEAR_DUPE_THRESHOLD = 0.9;
/** Finding I: no location guard, so the title bar is tighter. */
export const REMOTE_MERGE_THRESHOLD = 0.95;
export const GHOST_ABSENCE_THRESHOLD = 2;
export const POSTING_MAX_AGE_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;
/** ASCII unit separator — cannot survive normalization, so it cannot appear in a component. */
const KEY_SEPARATOR = '\u001f';

export type ConnectorRunStatus = 'ok' | 'error';

export interface SourcePoll {
  /** Did this source report the posting in this run? */
  seen: boolean;
  /** `connector_runs.status` for that source in that run. */
  runStatus: ConnectorRunStatus;
}

export interface DedupeOptions {
  /**
   * `posted_at` for a posting where NO source reported a parseable date. Defaults to now:
   * such a posting is at least "first seen now", whereas falling back to epoch 0 would park
   * it behind the 60-day filter and hide it forever. Pass it explicitly to keep a run
   * reproducible.
   */
  fallbackPostedAt?: number;
}

/**
 * The pinned serialization of the location component of a dedupe key. Exactly three shapes:
 *
 *   remote          -> "remote"              (country intentionally dropped: "Remote" and
 *                                             "Remote, USA" are one job, not two)
 *   nothing known   -> "unknown"
 *   anything else   -> "onsite|<city>|<state>|<country>", missing parts empty
 *
 *   "San Francisco, CA" -> "onsite|sf|CA|US"
 *   "Berlin, Germany"   -> "onsite|berlin||DE"
 *   "Remote"            -> "remote"
 *   null                -> "unknown"
 *
 * `remote` and `unknown` are deliberately distinct strings: an unknown location is not a
 * claim that the job is remote.
 */
export function locationKey(location: NormalizedLocation): string {
  if (location.is_remote) return 'remote';
  if (!location.city_norm && !location.state && !location.country) return 'unknown';
  return `onsite|${location.city_norm ?? ''}|${location.state ?? ''}|${location.country ?? ''}`;
}

function keyOf(
  companyNorm: string,
  titleNorm: string,
  locKey: string,
  publisherIdentity?: string,
): string {
  return sha256(
    [companyNorm, titleNorm, locKey, ...(publisherIdentity ? [publisherIdentity] : [])].join(
      KEY_SEPARATOR,
    ),
  );
}

/**
 * `sha256(company_norm ␟ title_norm ␟ location_key)` over RAW inputs — the normalizers run
 * here so no caller can forget them.
 */
export function dedupeKey(
  company: string | null | undefined,
  title: string | null | undefined,
  location: string | null | undefined,
): string {
  return keyOf(
    normalizeCompany(company),
    normalizeTitle(title),
    locationKey(normalizeLocation(location)),
  );
}

/**
 * Token-set ratio, pinned (finding E). Sørensen–Dice over the two *sets* of title tokens:
 *
 *   ratio = 2 * |A ∩ B| / (|A| + |B|)
 *
 * Tokens are the maximal alphanumeric runs of the lowercased string; duplicates collapse;
 * order is irrelevant; an empty side scores 0 (never merge on no evidence).
 *
 * Worked examples — these are the values, not an implementation detail to be re-observed:
 *
 *   "product designer"          vs "product designer"           -> 2*2/(2+2) = 1.00  merge
 *   "software engineer backend" vs "backend software engineer"  -> 2*3/(3+3) = 1.00  merge
 *   "product designer"          vs "product designer ii"        -> 2*2/(2+3) = 0.80  NO merge
 *   "senior product designer"   vs "product designer"           -> 2*2/(3+2) = 0.80  NO merge
 *   "a b c d e"                 vs "a b c d e f"                -> 2*5/(5+6) = 0.909 merge (0.90)
 *                                                                                    but not
 *                                                                                    across the
 *                                                                                    0.95 bar
 *   "product designer"          vs "backend engineer"           -> 2*0/(2+2) = 0.00  NO merge
 *
 * NOT fuzzywuzzy's `token_set_ratio`, which scores a strict subset ("Product Designer" vs
 * "Product Designer II") at 1.00 and would merge two different levels of the same role.
 */
export function tokenSetRatio(a: string, b: string): number {
  const left = tokenize(a);
  const right = tokenize(b);
  if (left.size === 0 || right.size === 0) return 0;

  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

function tokenize(input: string): Set<string> {
  return new Set(
    input
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter(Boolean),
  );
}

interface Group {
  dedupeKey: string;
  companyNorm: string;
  titleNorm: string;
  locationKey: string;
  location: NormalizedLocation;
  sources: PostingSource[];
  publisherIds: Map<string, string>;
}

function canonicalSourceUrl(value: string): string {
  try {
    const url = new URL(value);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_/i.test(key) || /^(?:gh_src|lever-source)$/i.test(key)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    url.pathname = url.pathname.replace(/\/+$/, '');
    return `${url.protocol}//${url.hostname.toLowerCase()}${url.port ? `:${url.port}` : ''}${url.pathname}${url.search}`;
  } catch {
    return value.replace(/#.*$/, '').replace(/\/+$/, '');
  }
}

/**
 * Stable identity in one connector's namespace. Exported so persisted source rows can be
 * backfilled with exactly the same URL compatibility rules as an incoming batch.
 */
export function publisherIdOf(
  raw: Pick<RawPosting, 'publisherId' | 'source' | 'sourceKind' | 'sourceUrl'>,
): string | null {
  const explicit = raw.publisherId === undefined ? '' : String(raw.publisherId).trim();
  if (explicit) return explicit;
  if (raw.sourceKind !== 'ats') return null;

  try {
    const url = new URL(raw.sourceUrl);
    if (raw.source === 'greenhouse') {
      const id =
        /\/(?:jobs?|positions?|detail)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1] ??
        url.searchParams.get('gh_jid') ??
        url.searchParams.get('token');
      if (id) return id;
    }
  } catch {
    // The canonical URL fallback below is deterministic for malformed fixture input too.
  }
  return canonicalSourceUrl(raw.sourceUrl) || null;
}

function publisherKey(source: string, id: string): string {
  return `${source}${KEY_SEPARATOR}${id}`;
}

function sharesPublisherIdentity(a: Group, b: Group): boolean {
  if (a.companyNorm !== b.companyNorm) return false;
  for (const [source, id] of a.publisherIds) {
    if (b.publisherIds.get(source) === id) return true;
  }
  return false;
}

function hasPublisherConflict(a: Group, b: Group): boolean {
  for (const [source, id] of a.publisherIds) {
    const other = b.publisherIds.get(source);
    if (other !== undefined && other !== id) return true;
  }
  return false;
}

/**
 * Collapse raw postings from every connector into one row per job.
 *
 * Four passes, in order:
 *  1. exact normalized key, including an ATS publisher identity when one is available;
 *  2. publisher identity — aliases/tracking URLs for one publisher job id;
 *  3. near-dupe — same company AND same location, title ratio ≥ 0.90;
 *  4. remote-vs-city (finding I) — same company, title ratio ≥ 0.95, and exactly one side
 *     remote. This is the pass that catches the same job listed as "San Francisco" on the
 *     ATS and "Remote" on an aggregator.
 *
 * Passes 3 and 4 may merge different publishers, but never two distinct ids from the same
 * publisher. That keeps cross-source dedupe useful without collapsing sibling requisitions.
 *
 * Within a pass the best-ranked group (by source priority, then earliest date, then URL)
 * keeps its identity and absorbs the others, so the ATS row's location survives as truth and
 * the output does not depend on input order.
 *
 * CONTRACT FOR THE INGEST WRITER (phase 2): the merged `dedupeKey` comes from the best group
 * present in THIS batch, so a run where the ATS connector failed can hand you a job keyed on
 * its aggregator identity instead. Match an incoming posting against
 * `posting_sources.source_url` first and fall back to `dedupe_key`, or that run will insert a
 * second row for a job you already have.
 */
export function dedupePostings(
  postings: RawPosting[],
  options: DedupeOptions = {},
): DedupedPosting[] {
  const fallbackPostedAt = options.fallbackPostedAt ?? Date.now();
  let groups = groupByKey(postings);

  // URL aliases and tracking variants for one publisher id are the same posting even when
  // their display title or location changed. This pass also makes the later conflict guard
  // independent of input order.
  groups = mergePass(groups, sharesPublisherIdentity);

  groups = mergePass(
    groups,
    (a, b) =>
      !hasPublisherConflict(a, b) &&
      a.companyNorm === b.companyNorm &&
      a.locationKey === b.locationKey &&
      tokenSetRatio(a.titleNorm, b.titleNorm) >= NEAR_DUPE_THRESHOLD,
  );

  groups = mergePass(
    groups,
    (a, b) =>
      !hasPublisherConflict(a, b) &&
      a.companyNorm === b.companyNorm &&
      a.location.is_remote !== b.location.is_remote &&
      tokenSetRatio(a.titleNorm, b.titleNorm) >= REMOTE_MERGE_THRESHOLD,
  );

  return groups.map((group) => materialize(group, fallbackPostedAt));
}

function groupByKey(postings: RawPosting[]): Group[] {
  const groups = new Map<string, Group>();

  for (const raw of postings) {
    const companyNorm = normalizeCompany(raw.company);
    const titleNorm = normalizeTitle(raw.title);
    const location = normalizeLocation(raw.location);
    const locKey = locationKey(location);
    const id = publisherIdOf(raw);
    const identity = id ? publisherKey(raw.source, id) : undefined;
    const key = keyOf(companyNorm, titleNorm, locKey, identity);
    const source: PostingSource = {
      source: raw.source,
      sourceKind: raw.sourceKind,
      sourceUrl: raw.sourceUrl,
      ...(id ? { publisherId: id } : {}),
      applyUrl: raw.applyUrl,
      sourcePriority: SOURCE_PRIORITY[raw.sourceKind],
      postedAt: raw.postedAt,
    };

    const existing = groups.get(key);
    if (existing) existing.sources.push(source);
    else {
      groups.set(key, {
        dedupeKey: key,
        companyNorm,
        titleNorm,
        locationKey: locKey,
        location,
        sources: [source],
        publisherIds: new Map(id ? [[raw.source, id]] : []),
      });
    }
  }

  return [...groups.values()];
}

function mergePass(groups: Group[], canMerge: (kept: Group, candidate: Group) => boolean): Group[] {
  const ranked = [...groups].sort((a, b) => compareSources(bestSource(a), bestSource(b)));
  const kept: Group[] = [];

  for (const group of ranked) {
    const target = kept.find((candidate) => canMerge(candidate, group));
    if (!target) {
      kept.push(group);
      continue;
    }
    target.sources.push(...group.sources);
    for (const [source, id] of group.publisherIds) target.publisherIds.set(source, id);
  }

  return kept;
}

function compareSources(a: PostingSource, b: PostingSource): number {
  return (
    a.sourcePriority - b.sourcePriority ||
    orderableTime(a.postedAt) - orderableTime(b.postedAt) ||
    (a.sourceUrl < b.sourceUrl ? -1 : a.sourceUrl > b.sourceUrl ? 1 : 0)
  );
}

function bestSource(group: Group): PostingSource {
  return [...group.sources].sort(compareSources)[0];
}

/** An unparseable date sorts last instead of poisoning every comparison with NaN. */
function orderableTime(value: number): number {
  return Number.isFinite(value) ? value : Number.MAX_SAFE_INTEGER;
}

function earliest(a: number, b: number): number {
  if (!Number.isFinite(a)) return b;
  if (!Number.isFinite(b)) return a;
  return Math.min(a, b);
}

function materialize(group: Group, fallbackPostedAt: number): DedupedPosting {
  const sources = collapseSourceUrls(group.sources).sort(compareSources);
  const dates = sources.map((source) => source.postedAt).filter((date) => Number.isFinite(date));
  const atsDates = sources
    .filter((source) => source.sourceKind === 'ats')
    .map((source) => source.postedAt)
    .filter((date) => Number.isFinite(date));

  const minAll = dates.length > 0 ? Math.min(...dates) : fallbackPostedAt;
  // FINDING D: floor the MIN at the ATS date. The ATS is authoritative about its own
  // posting, so an aggregator reporting a fabricated older date cannot age a live job past
  // the 60-day cutoff. Every source keeps its own date on its own row regardless.
  const postedAt = atsDates.length > 0 ? Math.max(minAll, Math.min(...atsDates)) : minAll;

  /** A URL only if it is one a browser may navigate to: http(s), nothing else. */
  function httpUrl(value: string | null | undefined): string | null {
    if (!value) return null;
    try {
      const { protocol } = new URL(value);
      return protocol === 'http:' || protocol === 'https:' ? value : null;
    } catch {
      return null;
    }
  }

  const ats = sources.filter((source) => source.sourceKind === 'ats');
  // The winner's application-form URL beats its posting page: the apply button should land
  // the user on the form, not one click away from it.
  const winner = (ats.length > 0 ? ats : sources)[0];
  // Scheme-checked here, where feed data becomes the apply button's href. React 19 does
  // rewrite `javascript:` in an href, but that is React's guarantee, not ours — it would not
  // survive a downgrade or a move to `window.open`. Checked at the seam instead.
  const canonicalUrl = httpUrl(winner?.applyUrl) ?? httpUrl(winner?.sourceUrl) ?? '';

  return { ...group, sources, postedAt, canonicalUrl };
}

/**
 * One source record per publisher identity when available, otherwise per canonicalized URL.
 * This collapses tracking and hostname aliases without conflating distinct requisitions.
 */
function collapseSourceUrls(sources: PostingSource[]): PostingSource[] {
  const byUrl = new Map<string, PostingSource>();

  for (const source of sources) {
    const identity = source.publisherId
      ? publisherKey(source.source, source.publisherId)
      : canonicalSourceUrl(source.sourceUrl);
    const existing = byUrl.get(identity);
    if (!existing) {
      byUrl.set(identity, { ...source });
      continue;
    }
    const postedAt = earliest(existing.postedAt, source.postedAt);
    byUrl.set(
      identity,
      source.sourcePriority < existing.sourcePriority
        ? { ...source, postedAt }
        : { ...existing, postedAt },
    );
  }

  return [...byUrl.values()];
}

/**
 * Ghost detection, one poll at a time (finding C).
 *
 * An absence counts ONLY when that source's `connector_runs` row for the poll is `ok`. Read
 * literally, "absent for 2 consecutive polls" would let a source that 500s twice delist
 * every posting it ever provided — one bad afternoon, mass false delisting.
 */
export function nextAbsenceCount(previous: number, poll: SourcePoll): number {
  if (poll.runStatus !== 'ok') return previous;
  return poll.seen ? 0 : previous + 1;
}

/** Delisted only once EVERY source has gone quiet — one live source keeps the posting live. */
export function isGhost(sources: { absenceCount: number }[]): boolean {
  return (
    sources.length > 0 &&
    sources.every((source) => source.absenceCount >= GHOST_ABSENCE_THRESHOLD)
  );
}

/** The 60-day cutoff is a query filter, never a delete: `posted_at >= cutoffTimestamp()`. */
export function cutoffTimestamp(now: number = Date.now()): number {
  return now - POSTING_MAX_AGE_DAYS * DAY_MS;
}

/** Inclusive at the boundary: exactly 60 days old is still visible, 61 is not. */
export function isWithinCutoff(postedAt: number, now: number = Date.now()): boolean {
  return postedAt >= cutoffTimestamp(now);
}
