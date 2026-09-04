import { afterEach, describe, expect, it } from 'vitest';

import { MAX_BATCH, sendConfigured, sendGate } from './send.ts';

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

const req = (token?: string) =>
  new Request('http://localhost/api/send', {
    method: 'POST',
    headers: token === undefined ? {} : { 'x-workie-send-token': token },
  });

describe('sendGate', () => {
  /**
   * The reason this guard exists separately from `writeGate`. That one protects sticky notes;
   * this one protects the ability to send mail as the account owner, from their real address,
   * to anyone. Different blast radius, so a leaked notes token must not open it.
   */
  it('is a DIFFERENT key from the notes write token', () => {
    process.env.WORKIE_SEND_TOKEN = 'send-key';
    process.env.WORKIE_WRITE_TOKEN = 'notes-key';
    expect(sendGate(req('notes-key'))?.status).toBe(401);
    expect(sendGate(req('send-key'))).toBeNull();
  });

  it('FAILS CLOSED when no send token is configured', () => {
    delete process.env.WORKIE_SEND_TOKEN;
    // Not 401: the caller is not wrong, the deployment is unconfigured. But it must not send.
    expect(sendGate(req('anything'))?.status).toBe(503);
  });

  it('refuses a wrong token, a missing one, a prefix and a same-length near-miss', () => {
    process.env.WORKIE_SEND_TOKEN = 's3cret';
    for (const token of ['nope', undefined, 's3cre', 's3crets', '', 'S3CRET']) {
      expect(sendGate(req(token))?.status, `token ${JSON.stringify(token)}`).toBe(401);
    }
  });

  it('tolerates the whitespace a pasted env var carries', () => {
    process.env.WORKIE_SEND_TOKEN = '  s3cret\n';
    expect(sendGate(req('s3cret'))).toBeNull();
  });
});

describe('sendConfigured', () => {
  it('needs BOTH halves of the credential and the token', () => {
    process.env.WORKIE_SEND_TOKEN = 't';
    process.env.WORKIE_GMAIL_USER = 'a@b.com';
    delete process.env.WORKIE_GMAIL_APP_PASSWORD;
    // A half-configured deploy must report unconfigured rather than fail at send time.
    expect(sendConfigured()).toBe(false);

    process.env.WORKIE_GMAIL_APP_PASSWORD = 'xxxx xxxx xxxx xxxx';
    expect(sendConfigured()).toBe(true);

    delete process.env.WORKIE_SEND_TOKEN;
    expect(sendConfigured()).toBe(false);
  });
});

describe('the batch shape', () => {
  /**
   * A batch is a queue of individual messages, never one message with many recipients: each
   * envelope carries only its own address, so nobody learns who else was contacted, and each
   * body is the one written for that person. The cap bounds a stuck loop — Gmail's own
   * ceiling is ~500/day and sustained cold volume is what gets an account restricted.
   */
  it('is capped well below anything that would look like bulk', () => {
    expect(MAX_BATCH).toBeGreaterThan(1);
    expect(MAX_BATCH).toBeLessThanOrEqual(10);
  });
});
