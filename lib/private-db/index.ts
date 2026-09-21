import 'server-only';
import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { closeSync, openSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrivateConfigurationError, validatePrivateConfig, type CorpusGuards, type PrivateConfig } from './config.ts';
import * as schema from './schema.ts';

export { PrivateConfigurationError } from './config.ts';
export type PrivateDb = LibSQLDatabase<typeof schema> & { $client: Client };

export function openPrivateDb(config: PrivateConfig, guards?: CorpusGuards): PrivateDb {
  const validated = validatePrivateConfig(config, guards);
  try {
    if (validated.url.startsWith('file:')) {
      try {
        closeSync(openSync(new URL(validated.url), 'wx', 0o600));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    return drizzle(createClient(validated), { schema });
  } catch {
    throw new PrivateConfigurationError();
  }
}

const cache = globalThis as typeof globalThis & {
  __workiePrivateDb?: { config: PrivateConfig; db: PrivateDb };
};

export function getPrivateDb(): PrivateDb {
  const config = validatePrivateConfig({
    url: process.env.WORKIE_PRIVATE_DATABASE_URL ?? '',
    authToken: process.env.WORKIE_PRIVATE_DATABASE_AUTH_TOKEN,
  });
  if (process.env.VERCEL && !config.url.startsWith('https:')) throw new PrivateConfigurationError();
  const previous = cache.__workiePrivateDb;
  if (previous && !previous.db.$client.closed) {
    if (previous.config.url !== config.url || previous.config.authToken !== config.authToken) {
      throw new PrivateConfigurationError();
    }
    return previous.db;
  }
  const db = openPrivateDb(config);
  cache.__workiePrivateDb = { config, db };
  return db;
}

/** Explicit operator action only; never called by getPrivateDb or public requests. */
export async function migratePrivateDb(db: PrivateDb): Promise<void> {
  const { migrate } = await import('drizzle-orm/libsql/migrator');
  await migrate(db, { migrationsFolder: join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'drizzle-private') });
}
