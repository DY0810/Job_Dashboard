import { afterEach, describe, expect, it } from 'vitest';

import { WRITE_HEADER, writeGate } from './write-gate.ts';

const req = (token?: string) =>
  new Request('http://localhost/api/notes/1', {
    method: 'DELETE',
    headers: token === undefined ? {} : { [WRITE_HEADER]: token },
  });

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe('writeGate', () => {
  it('allows a matching token', () => {
    process.env.WORKIE_WRITE_TOKEN = 's3cret';
    expect(writeGate(req('s3cret'))).toBeNull();
  });

  it('refuses a wrong token, a missing one, a prefix, and a same-length near-miss', () => {
    process.env.WORKIE_WRITE_TOKEN = 's3cret';
    for (const token of ['nope', undefined, 's3cre', 's3crets', '', 'S3CRET']) {
      expect(writeGate(req(token))?.status, `token ${JSON.stringify(token)}`).toBe(401);
    }
  });

  it('survives a token pasted into a hosting dashboard with stray whitespace', () => {
    // Fetch strips whitespace from header values, so an untrimmed env var would match
    // nothing and 401 every write. Both sides are trimmed; this is why.
    process.env.WORKIE_WRITE_TOKEN = '  s3cret\n';
    expect(writeGate(req('s3cret'))).toBeNull();
  });

  it('FAILS CLOSED when hosted with no token configured', () => {
    delete process.env.WORKIE_WRITE_TOKEN;
    process.env.VERCEL = '1';
    // The whole point: forgetting the variable must not reopen the board to everyone.
    expect(writeGate(req())?.status).toBe(503);
  });

  it('is open locally when no token is configured, so `next dev` still works', () => {
    delete process.env.WORKIE_WRITE_TOKEN;
    delete process.env.VERCEL;
    expect(writeGate(req())).toBeNull();
  });
});
