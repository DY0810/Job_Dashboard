import { afterEach, describe, expect, it, vi } from 'vitest';
import nodemailer from 'nodemailer';
import { createAuthMailSink } from './auth-mail';

vi.mock('server-only', () => ({}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('auth SMTP adapter without network delivery', () => {
  it('requires the explicitly selected configured sender, never the outreach default', async () => {
    vi.stubEnv('WORKIE_GMAIL_USER', 'first@example.test');
    vi.stubEnv('WORKIE_GMAIL_APP_PASSWORD', 'synthetic-first-password');
    vi.stubEnv('WORKIE_GMAIL_USER_2', 'auth@example.test');
    vi.stubEnv('WORKIE_GMAIL_APP_PASSWORD_2', 'synthetic-second-password');
    const sendMail = vi.fn().mockResolvedValue({});
    const close = vi.fn();
    const create = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({ sendMail, close } as unknown as ReturnType<typeof nodemailer.createTransport>);
    expect(() => createAuthMailSink('')).toThrow('Authentication mail is unavailable.');
    expect(() => createAuthMailSink('unknown@example.test')).toThrow('Authentication mail is unavailable.');
    await createAuthMailSink('auth@example.test')({ kind: 'verification', to: 'alice@example.test', url: 'https://workie.example.test/synthetic-link' });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      requireTLS: true, auth: { user: 'auth@example.test', pass: 'synthetic-second-password' },
    }));
    expect(sendMail).toHaveBeenCalledWith(expect.objectContaining({
      from: 'auth@example.test', to: 'alice@example.test', disableFileAccess: true, disableUrlAccess: true,
    }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('sanitizes failures and always closes the transport', async () => {
    vi.stubEnv('WORKIE_GMAIL_USER', 'auth@example.test');
    vi.stubEnv('WORKIE_GMAIL_APP_PASSWORD', 'synthetic-password');
    const close = vi.fn();
    vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: vi.fn().mockRejectedValue(new Error('synthetic-secret SMTP response')), close,
    } as unknown as ReturnType<typeof nodemailer.createTransport>);
    await expect(createAuthMailSink('auth@example.test')({
      kind: 'reset', to: 'alice@example.test', url: 'https://workie.example.test/synthetic-link',
    })).rejects.toThrow('Authentication email delivery failed.');
    expect(close).toHaveBeenCalledOnce();
  });
});
