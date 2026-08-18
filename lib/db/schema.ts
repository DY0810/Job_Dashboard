// PHASE 0 STUB — DO NOT BUILD ON THIS.
// This is a single minimal table that exists only to prove the Drizzle + better-sqlite3 +
// drizzle-kit toolchain round-trips (generate -> migrate -> query) end to end.
//
// Phase 1 (worky/p1-dedupe, see plans/worky.md §"Phase 1") replaces this file WHOLESALE
// with the real four-table schema: postings, posting_sources, enrichment_cache,
// connector_runs — including the unique index on postings.dedupe_key and on
// posting_sources(posting_id, source_url). Do not preserve this version; do not add
// columns to this table incrementally.

import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";

export const postings = sqliteTable("postings", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  dedupeKey: text("dedupe_key").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
