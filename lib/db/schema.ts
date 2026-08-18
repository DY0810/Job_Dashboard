/**
 * The complete Workie schema — four tables, landed in one migration on purpose.
 *
 * Phases 4 (classification), 5 (voice badges) and 6 (aggregators) run in parallel. If each
 * added its own migration for the columns it needs, `drizzle/` would conflict three ways.
 * So every column those phases will write already exists here, unpopulated.
 */

import { integer, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

/** One row per DEDUPED job. `dedupe_key` = sha256(company_norm ␟ title_norm ␟ location_key). */
export const postings = sqliteTable('postings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dedupeKey: text('dedupe_key').notNull().unique(),
  /** The ATS URL when any source is an ATS, else the highest-priority source URL. */
  canonicalUrl: text('canonical_url').notNull(),
  /** MIN across sources, floored at the ATS date when one exists (finding D). */
  postedAt: integer('posted_at', { mode: 'timestamp_ms' }).notNull(),
  /** Set by the ghost pass after 2 consecutive absences from *successful* polls (finding C). */
  delistedAt: integer('delisted_at', { mode: 'timestamp_ms' }),
  firstSeenRun: text('first_seen_run').notNull(),

  // As listed by the highest-priority source. Display only — dedupe never reads these.
  company: text('company').notNull(),
  title: text('title').notNull(),
  /** Full normalized body. Drawer-only; never selected into the table query. */
  description: text('description'),
  /** sha256(normalizeDescription(body)) — the `enrichment_cache` key for this posting. */
  descriptionHash: text('description_hash'),

  // Normalized components, from lib/normalize.ts.
  companyNorm: text('company_norm').notNull(),
  titleNorm: text('title_norm').notNull(),
  locationKey: text('location_key').notNull(),
  cityNorm: text('city_norm'),
  state: text('state'),
  country: text('country'),
  isRemote: integer('is_remote', { mode: 'boolean' }).notNull().default(false),

  // Classification (phase 4). Null until the enrichment pass runs.
  enrichedAt: integer('enriched_at', { mode: 'timestamp_ms' }),
  track: text('track', { enum: ['design', 'engineering'] }),
  seniority: text('seniority', { enum: ['entry', 'junior', 'mid', 'senior+'] }),
  employmentType: text('employment_type', {
    enum: ['full-time', 'part-time', 'contract', 'freelance', 'internship'],
  }),
  internshipSeason: text('internship_season', { enum: ['summer', 'fall', 'winter', 'spring'] }),
  /** true | false | NULL. NULL is "unknown": it matches neither pay chip (finding G). */
  paid: integer('paid', { mode: 'boolean' }),
  workMode: text('work_mode', { enum: ['remote', 'hybrid', 'onsite'] }),
  /** The human-readable location as classified. `city_norm`/`state` above are the keys. */
  location: text('location'),
  payRateMin: real('pay_rate_min'),
  payRateMax: real('pay_rate_max'),
  payRatePeriod: text('pay_rate_period', { enum: ['hour', 'week', 'month', 'year'] }),
  expectedGrad: text('expected_grad'),
  /** Engineering only — the Design tab has no summary column, so none is generated. */
  summary: text('summary'),
  responsibilities: text('responsibilities', { mode: 'json' }).$type<string[]>(),
  skills: text('skills', { mode: 'json' }).$type<string[]>(),
  education: text('education', { mode: 'json' }).$type<string[]>(),
  /** Filter chips, e.g. `voice-ai` (phase 5). Badges are controls, not decoration. */
  badges: text('badges', { mode: 'json' }).$type<string[]>(),
});

/** One row per (posting, source). A source is NEVER discarded, only added to. */
export const postingSources = sqliteTable(
  'posting_sources',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    postingId: integer('posting_id')
      .notNull()
      .references(() => postings.id, { onDelete: 'cascade' }),
    /** Connector name, e.g. `greenhouse`, `remoteok`. */
    source: text('source').notNull(),
    sourceUrl: text('source_url').notNull(),
    /** This source's own date, never the merged one. */
    postedAt: integer('posted_at', { mode: 'timestamp_ms' }).notNull(),
    /** 1 ATS · 2 aggregator · 3 RSS · 4 scraped · 5 GitHub repo. See SOURCE_PRIORITY. */
    sourcePriority: integer('source_priority').notNull(),
    lastSeenRun: text('last_seen_run').notNull(),
    /** Consecutive absences from SUCCESSFUL polls of this source only (finding C). */
    absenceCount: integer('absence_count').notNull().default(0),
  },
  (table) => [uniqueIndex('posting_sources_posting_url_idx').on(table.postingId, table.sourceUrl)],
);

/**
 * sha256(normalizeDescription(body)) -> the classification JSON.
 *
 * Not keyed to a posting and never cascaded: it outlives posting rows deliberately. This
 * table is the reason a full re-poll of an unchanged corpus costs ~$0.
 */
export const enrichmentCache = sqliteTable('enrichment_cache', {
  contentHash: text('content_hash').primaryKey(),
  classification: text('classification', { mode: 'json' }).notNull(),
  /** Which model produced it — a model change invalidates by writing a new row set. */
  model: text('model').notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
});

/**
 * One row per (run, connector). The ghost pass reads this to tell a real absence from a
 * failed fetch, which is why it exists from phase 1 rather than arriving with ops.
 */
export const connectorRuns = sqliteTable(
  'connector_runs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    runId: text('run_id').notNull(),
    connector: text('connector').notNull(),
    status: text('status', { enum: ['ok', 'error'] }).notNull(),
    fetched: integer('fetched').notNull().default(0),
    newPostings: integer('new_postings').notNull().default(0),
    merged: integer('merged').notNull().default(0),
    durationMs: integer('duration_ms').notNull().default(0),
    /** Message only — never a key, never a full response body. */
    error: text('error'),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (table) => [uniqueIndex('connector_runs_run_connector_idx').on(table.runId, table.connector)],
);
