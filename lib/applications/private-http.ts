import 'server-only';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { lookupApplicant, privateJson } from '../applicant-access.ts';
import { getPrivateDb } from '../private-db/index.ts';
import { rateLimit } from '../private-db/schema.ts';
import { readDraftKeyConfig } from './draft-key.ts';
import { ApplicantPreconditionError, assertExpectedApplicant } from './applicant-precondition.ts';

export const MAX_PRIVATE_JSON = 128 * 1024;
export class PrivateInputError extends Error {
  constructor(public status: number, message: string, public code?: string) { super(message); }
}
export async function readPrivateJson<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') {
    throw new PrivateInputError(415, 'JSON required.');
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abortRead: (() => void) | undefined;
    try {
      if (request.signal.aborted) throw new PrivateInputError(400, 'Invalid request body.');
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PrivateInputError(408, 'Request body timed out.')), 8000);
        abortRead = () => reject(new PrivateInputError(400, 'Invalid request body.'));
        request.signal.addEventListener('abort', abortRead, { once: true });
      });
      for (;;) {
        const { done, value } = await Promise.race([reader.read(), deadline]);
        if (request.signal.aborted) throw new PrivateInputError(400, 'Invalid request body.');
        if (done) break;
        size += value.byteLength;
        if (size > MAX_PRIVATE_JSON) {
          throw new PrivateInputError(413, 'Request too large.');
        }
        chunks.push(value);
      }
    } catch (error) {
      if (error instanceof PrivateInputError) throw error;
      throw new PrivateInputError(400, 'Invalid request body.');
    } finally {
      clearTimeout(timer);
      if (abortRead) request.signal.removeEventListener('abort', abortRead);
      // A source's cancellation promise must not delay the response or lock release.
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  let input: unknown;
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
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
