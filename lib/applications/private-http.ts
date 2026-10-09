import 'server-only';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { lookupApplicant, privateJson } from '../applicant-access.ts';
import { getPrivateDb } from '../private-db/index.ts';
import { rateLimit } from '../private-db/schema.ts';
import { readDraftKeyConfig } from './draft-key.ts';
import { ApplicantPreconditionError, assertExpectedApplicant } from './applicant-precondition.ts';
import { readCapped } from '../read-capped.ts';

export const MAX_PRIVATE_JSON = 128 * 1024;
export class PrivateInputError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export async function readPrivateJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new PrivateInputError(415, 'JSON required.');
  }
  let bytes: Uint8Array = new Uint8Array();
  if (request.body) {
    const invalid = () => new PrivateInputError(400, 'Invalid request body.');
    try {
      bytes = await readCapped(request.body, MAX_PRIVATE_JSON, {
        overflow: () => new PrivateInputError(413, 'Request too large.'),
        timeout: { ms: 8000, error: () => new PrivateInputError(408, 'Request body timed out.') },
        abort: { signal: request.signal, error: invalid },
      });
    } catch (error) {
      if (error instanceof PrivateInputError) throw error;
      throw invalid();
    }
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw new PrivateInputError(400, 'Invalid JSON.'); }
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new PrivateInputError(400, 'Invalid request fields.');
  return parsed.data;
}

export async function privateEndpoint(
  request: Request,
  action: (ownerId: string) => Promise<unknown>,
): Promise<Response> {
  let headers: Headers | undefined;
  try {
    const result = await lookupApplicant(request);
    if (result instanceof Response) return result;
    headers = result.response.headers;
    assertExpectedApplicant(request, result.applicant.ownerId);
    if (!['GET', 'HEAD'].includes(request.method)) readDraftKeyConfig();
    const window = Math.floor(Date.now() / 60_000) * 60_000;
    const key = `private-applicant:${result.applicant.ownerId}`;
    const [limit] = await getPrivateDb().insert(rateLimit).values({
      id: crypto.randomUUID(), key, count: 1, lastRequest: window,
    }).onConflictDoUpdate({
      target: rateLimit.key,
      set: {
        count: sql`case when ${rateLimit.lastRequest} < ${window} then 1 else ${rateLimit.count} + 1 end`,
        lastRequest: sql`case when ${rateLimit.lastRequest} < ${window} then ${window} else ${rateLimit.lastRequest} end`,
      },
    }).returning({ count: rateLimit.count });
    if (limit.count > 60) throw new PrivateInputError(429, 'Too many private requests. Retry next minute.');
    return privateJson(await action(result.applicant.ownerId), { headers });
  } catch (error) {
    if (error instanceof PrivateInputError || error instanceof ApplicantPreconditionError) {
      return privateJson({ error: error.message, ...(error instanceof PrivateInputError && error.code ? { code: error.code } : {}) },
        { status: error.status, headers });
    }
    return privateJson({ error: 'Private applicant storage unavailable.' }, { status: 503, headers });
  }
}
