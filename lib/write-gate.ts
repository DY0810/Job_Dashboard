/**
 * The write gate for Talkie.
 *
 * The board has no accounts by design — it is shared by link, and the link is the invitation.
 * That is fine for reading. It is not fine for `PATCH` and `DELETE`: note ids are sequential
 * integers, notes are the ONE table `push:remote` deliberately does not mirror, and so a
 * stranger walking `/api/notes/1..n` with DELETE destroys the only copy that exists.
 *
 * So writes carry a shared token and reads do not. One secret, pasted once by each person who
 * is meant to write, kept in their browser.
 *
 * The unset case fails CLOSED where it matters. A hosted deploy with no token configured
 * refuses every write rather than serving them to the whole internet — the mistake this file
 * exists to prevent should not be reachable by forgetting an environment variable. Locally,
 * where the database is a file on one laptop, an unset token means "no gate", so `next dev`
 * works out of the box.
 */

import { timingSafeEqual } from 'node:crypto';

export const WRITE_HEADER = 'x-workie-token';

/**
 * Constant time in the token's content. Length is compared first and leaks, which is
 * deliberate: `timingSafeEqual` throws on a length mismatch, and a token's length is not the
 * secret — its bytes are.
 */
function sameToken(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Returns null when the request may write, or the Response to send back when it may not.
 * Call it FIRST in every mutating handler, before the database is touched.
 */
export function writeGate(request: Request): Response | null {
  // Trimmed, because the header side is trimmed for us: the Fetch spec strips surrounding
  // whitespace from header values, so a token pasted into a hosting dashboard with a trailing
  // newline would never match and would 401 every write with nothing to show why.
  const expected = process.env.WORKIE_WRITE_TOKEN?.trim();
  if (expected) {
    const got = request.headers.get(WRITE_HEADER);
    return got && sameToken(got, expected)
      ? null
      : Response.json({ error: 'not authorized' }, { status: 401 });
  }
  if (process.env.VERCEL) {
    // Hosted and unconfigured: refuse rather than expose. See the note above.
    return Response.json({ error: 'writes are not configured' }, { status: 503 });
  }
  return null;
}
