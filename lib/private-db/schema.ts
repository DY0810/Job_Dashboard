import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// Adapted from Better Auth v1.7.5's generated SQLite snapshot (core fields only):
// https://github.com/better-auth/better-auth/blob/v1.7.5/packages/cli/test/__snapshots__/auth-schema-sqlite.txt
// Runtime date defaults avoid a server SQLite-version dependency; rateLimit uses getAuthTables.
// Logical field names stay intact; only physical table/column names are private.
export const user = sqliteTable('private_user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: integer('email_verified', { mode: 'boolean' }).notNull().default(false),
  image: text('image'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [check('private_user_email_verified_check', sql`${table.emailVerified} in (0, 1)`)]);

export const session = sqliteTable('private_session', {
  id: text('id').primaryKey(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  token: text('token').notNull().unique(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$onUpdate(() => new Date()),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
}, (table) => [index('private_session_user_id_idx').on(table.userId)]);

export const account = sqliteTable('private_account', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: integer('access_token_expires_at', { mode: 'timestamp_ms' }),
  refreshTokenExpiresAt: integer('refresh_token_expires_at', { mode: 'timestamp_ms' }),
  scope: text('scope'),
  password: text('password'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$onUpdate(() => new Date()),
}, (table) => [index('private_account_user_id_idx').on(table.userId)]);

export const verification = sqliteTable('private_verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' }).notNull().$defaultFn(() => new Date()).$onUpdate(() => new Date()),
}, (table) => [index('private_verification_identifier_idx').on(table.identifier)]);

export const rateLimit = sqliteTable('private_rate_limit', {
  id: text('id').primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: integer('last_request').notNull().$defaultFn(() => Date.now()),
}, (table) => [
  check('private_rate_limit_count_check', sql`typeof(${table.count}) = 'integer' and ${table.count} >= 0`),
  check('private_rate_limit_last_request_check', sql`typeof(${table.lastRequest}) = 'integer' and ${table.lastRequest} >= 0`),
]);
