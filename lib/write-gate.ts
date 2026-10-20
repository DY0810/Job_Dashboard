/** Shared-secret checks for the scheduler and household auth. */

import { timingSafeEqual } from 'node:crypto';

/**
 * Constant time in the token's content. Length is compared first and leaks, which is
 * deliberate: `timingSafeEqual` throws on a length mismatch, and a token's length is not the
 * secret — its bytes are. Every token and signature check shares this one compare.
 */
export function safeEqual(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The scheduler has its own token. */
export function cronGate(request: Request): Response | null {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return Response.json({ error: 'scheduler is not configured' }, { status: 503 });
  const got = request.headers.get('authorization');
  return got && safeEqual(got, `Bearer ${expected}`)
    ? null
    : Response.json({ error: 'not authorized' }, { status: 401 });
}
