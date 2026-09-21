import 'server-only';
import { statSync } from 'node:fs';
import { createRequire } from 'node:module';
import type Database from 'better-sqlite3';
import { getDb, prefersTurso, type ReadDb } from '../db/index.ts';
import * as schema from '../db/schema.ts';

const require = createRequire(import.meta.url);
let local: { path: string; dev: number; ino: number; client: Database.Database; db: ReadDb } | undefined;

/** Private readers must never create, migrate or change journal mode on the collector's file. */
export function getDiscoveryCorpus(): ReadDb {
  if (prefersTurso()) return getDb();
  const path = process.env.WORKIE_DB ?? 'workie.db';
  // Collector recovery can rename a new snapshot over this path while the old handle stays open.
  const { dev, ino } = statSync(path);
  if (local?.path === path && local.dev === dev && local.ino === ino && local.client.open) return local.db;
  local?.client.close();
  const SQLite = require('better-sqlite3') as typeof Database;
  const { drizzle } = require('drizzle-orm/better-sqlite3') as typeof import('drizzle-orm/better-sqlite3');
  const client = new SQLite(path, { readonly: true, fileMustExist: true });
  local = { path, dev, ino, client, db: drizzle(client, { schema }) };
  return local.db;
}
