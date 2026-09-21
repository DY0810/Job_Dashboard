import { expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createClient, type Client, type InValue, type ResultSet, type Value } from '@libsql/client';
import { migratePrivateDb, openPrivateDb } from './index.ts';
import { user } from './schema.ts';

vi.mock('server-only', () => ({}));

type WireValue = { type: string; value?: string | number; base64?: string };
type Statement = { sql?: string; sql_id?: number; args?: WireValue[] };
type Condition = { type: 'ok' | 'error'; step: number } |
  { type: 'not'; cond: Condition } | { type: 'and' | 'or'; conds: Condition[] };
type Request = { type: string; stmt?: Statement; sql_id?: number; sql?: string;
  batch?: { steps: { stmt: Statement; condition?: Condition }[] } };

function decode(value: WireValue): InValue {
  if (value.type === 'null') return null;
  if (value.type === 'integer') return BigInt(value.value!);
  if (value.type === 'float') return Number(value.value);
  if (value.type === 'text') return String(value.value);
  if (value.type === 'blob') return Buffer.from(value.base64!, 'base64');
  throw new Error('Unsupported fixture value');
}
function encode(value: Value): WireValue {
  if (value === null) return { type: 'null' };
  if (typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value))) {
    return { type: 'integer', value: String(value) };
  }
  if (typeof value === 'number') return { type: 'float', value };
  if (typeof value === 'string') return { type: 'text', value };
  return { type: 'blob', base64: Buffer.from(value).toString('base64') };
}
function result(value: ResultSet) {
  return {
    cols: value.columns.map((name, i) => ({ name, decltype: value.columnTypes[i] })),
    rows: value.rows.map((row) => value.columns.map((_, i) => encode(row[i]))),
    affected_row_count: value.rowsAffected,
    last_insert_rowid: value.lastInsertRowid?.toString() ?? null,
  };
}

// Narrow Hrana v2 fixture, not a Turso server. Real SDK HTTP encoding/transactions,
// stdlib loopback transport, and real scratch libSQL execute all SQL.
// Protocol source: installed @libsql/hrana-client http/shared json_{encode,decode}.
async function fixture(path: string) {
  const streams = new Map<string, { db: Client; sql: Map<number, string> }>();
  const statements: string[] = [];
  let sequence = 0;
  const server = createServer(async (req, res) => {
    if (req.url !== '/v2/pipeline' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    if (req.headers.authorization !== 'Bearer synthetic-fixture') { res.writeHead(401).end(); return; }
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { baton?: string; requests: Request[] };
      const baton = body.baton ?? String(++sequence);
      if (!streams.has(baton)) {
        streams.set(baton, { db: createClient({ url: pathToFileURL(path).href }), sql: new Map() });
      }
      const stream = streams.get(baton)!;
      const execute = async (stmt: Statement) => {
        const sql = stmt.sql ?? stream.sql.get(stmt.sql_id!);
        if (!sql) throw new Error('Missing fixture SQL');
        statements.push(sql);
        return result(await stream.db.execute({ sql, args: (stmt.args ?? []).map(decode) }));
      };
      const results = [];
      for (const request of body.requests) {
        try {
          let response: object = { type: request.type };
          if (request.type === 'execute') response = { ...response, result: await execute(request.stmt!) };
          else if (request.type === 'store_sql') stream.sql.set(request.sql_id!, request.sql!);
          else if (request.type === 'close_sql') stream.sql.delete(request.sql_id!);
          else if (request.type === 'close') { stream.db.close(); streams.delete(baton); }
          else if (request.type === 'batch') {
            const step_results: (ReturnType<typeof result> | null)[] = [];
            const step_errors: ({ message: string; code: string } | null)[] = [];
            const permits = (condition?: Condition): boolean => {
              if (!condition) return true;
              if (condition.type === 'ok') return step_results[condition.step] != null;
              if (condition.type === 'error') return step_errors[condition.step] != null;
              if (condition.type === 'not') return !permits(condition.cond);
              if (condition.type === 'and') return condition.conds.every(permits);
              if (condition.type === 'or') return condition.conds.some(permits);
              throw new Error('Unsupported fixture condition');
            };
            for (const step of request.batch!.steps) {
              if (!permits(step.condition)) { step_results.push(null); step_errors.push(null); continue; }
              try { step_results.push(await execute(step.stmt)); step_errors.push(null); }
              catch {
                step_results.push(null);
                step_errors.push({ message: 'Synthetic SQL rejection', code: 'SQLITE_CONSTRAINT' });
              }
            }
            response = { ...response, result: { step_results, step_errors } };
          } else throw new Error('Unsupported fixture operation');
          results.push({ type: 'ok', response });
        } catch {
          results.push({ type: 'error', error: { message: 'Synthetic SQL rejection', code: 'SQLITE_ERROR' } });
        }
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ baton: streams.has(baton) ? baton : null, base_url: null, results }));
    } catch { res.writeHead(500).end(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture port unavailable');
  return {
    url: `http://127.0.0.1:${address.port}`,
    statements,
    async close() {
      for (const stream of streams.values()) stream.db.close();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}

it('migrates, commits and rolls back through the real libSQL HTTP client and loopback fixture', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'workie-private-http-'));
  const server = await fixture(join(dir, 'http.db'));
  const db = openPrivateDb({ url: server.url, authToken: 'synthetic-fixture' });
  try {
    expect(db.$client.protocol).toBe('http');
    await migratePrivateDb(db);
    await migratePrivateDb(db);
    const now = new Date('2026-09-20T12:34:56.789Z');
    const row = { id: 'http-user', name: 'Fixture', email: 'http@example.test', emailVerified: true, createdAt: now, updatedAt: now };
    await expect(db.transaction(async (tx) => {
      await tx.insert(user).values(row);
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect((await tx.select().from(user))[0].createdAt).toEqual(now);
      throw new Error('HTTP rollback');
    })).rejects.toThrow('HTTP rollback');
    expect(await db.select().from(user)).toEqual([]);
    await db.transaction(async (tx) => { await tx.insert(user).values(row); });
    expect(await db.select().from(user)).toEqual([expect.objectContaining(row)]);
    expect(server.statements).toContain('ROLLBACK');
    expect(server.statements).toContain('COMMIT');
  } finally {
    db.$client.close();
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
