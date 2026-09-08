import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mail = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@/lib/send', async (original) => ({
  ...await original<typeof import('../../../lib/send.ts')>(),
  sendAll: mail.send,
}));
import { POST } from './route.ts';

beforeEach(() => {
  vi.stubEnv('WORKIE_SEND_TOKEN', 'test-token');
  vi.stubEnv('WORKIE_GMAIL_USER', 'sender@example.test');
  vi.stubEnv('WORKIE_GMAIL_APP_PASSWORD', 'test-password');
  mail.send.mockReset().mockResolvedValue({ sent: 1, failed: [] });
});
afterEach(() => vi.unstubAllEnvs());

const request = (messages: unknown[], token = 'test-token') => new Request('https://workie.test/api/send', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-workie-send-token': token },
  body: JSON.stringify({ from: 'sender@example.test', messages }),
});
const message = { to: 'recipient@example.test', subject: 'test', body: 'test' };

it('checks authorization before handling a message', async () => {
  expect((await POST(request([message], 'wrong'))).status).toBe(401);
  expect(mail.send).not.toHaveBeenCalled();
});

it.each(['one@example.test,two@example.test', 'one@example.test\nBcc: two@example.test'])(
  'rejects multiple recipients or header input: %s', async (to) => {
    expect((await POST(request([{ ...message, to }]))).status).toBe(400);
    expect(mail.send).not.toHaveBeenCalled();
  },
);

it('rejects an eleventh message before opening SMTP', async () => {
  expect((await POST(request(Array.from({ length: 11 }, () => message)))).status).toBe(400);
  expect(mail.send).not.toHaveBeenCalled();
});

it('returns the per-message failure index for retry', async () => {
  mail.send.mockResolvedValue({ sent: 0, failed: [{ index: 0, to: message.to, reason: 'rejected' }] });
  const response = await POST(request([message]));
  expect(response.status).toBe(207);
  expect(await response.json()).toMatchObject({ failed: [{ index: 0 }] });
});
