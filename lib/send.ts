/**
 * Sending, over Gmail SMTP with an app password.
 *
 * WHY SMTP AND NOT THE GMAIL API. `gmail.send` is a sensitive scope, and Google's own docs
 * are explicit: a consent screen with external user type and a publishing status of
 * "Testing" issues a refresh token that EXPIRES IN 7 DAYS. Leaving Testing means app
 * verification — privacy policy, verified domain, demo video, multi-week review — for a tool
 * with two users. An app password has no expiry, needs no verification, and Gmail still
 * copies the message into the account's Sent folder, so replies thread where you expect.
 *
 * WHY A SEPARATE TOKEN. `WORKIE_WRITE_TOKEN` guards sticky notes; losing it costs you a
 * whiteboard. This guards the ability to send mail AS YOU, from your real address, to anyone
 * — a different order of damage, so it gets its own key. One capability, one credential.
 *
 * The app password never reaches the browser. It is read here, in a server route, from an
 * environment variable that is not `NEXT_PUBLIC_`, and the client only ever posts the text
 * it wants sent.
 */

import { timingSafeEqual } from 'node:crypto';

import nodemailer from 'nodemailer';

export type Outgoing = { to: string; subject: string; body: string };

/** Both halves of the credential, or nothing. A half-configured deploy must not half-send. */
function credentials(): { user: string; pass: string } | null {
  const user = process.env.WORKIE_GMAIL_USER?.trim();
  // Google prints the app password in four groups of four; the spaces are presentation.
  const pass = process.env.WORKIE_GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  return user && pass ? { user, pass } : null;
}

export function sendConfigured(): boolean {
  return credentials() !== null && Boolean(process.env.WORKIE_SEND_TOKEN?.trim());
}

/**
 * Constant-time in the token's bytes; length is compared first and leaks, which is fine —
 * a token's length is not the secret. Mirrors `lib/write-gate.ts` deliberately: two guards
 * that differ only in which capability they open should not differ in how they compare.
 */
function sameToken(got: string, expected: string): boolean {
  const a = Buffer.from(got);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sendGate(request: Request): Response | null {
  const expected = process.env.WORKIE_SEND_TOKEN?.trim();
  if (!expected) {
    // Fails CLOSED, like the write gate: an unset key must never mean "anyone may send".
    return Response.json({ error: 'sending is not configured' }, { status: 503 });
  }
  const got = request.headers.get('x-workie-send-token');
  return got && sameToken(got, expected)
    ? null
    : Response.json({ error: 'not authorized to send' }, { status: 401 });
}

/**
 * A batch is a QUEUE OF INDIVIDUAL MESSAGES, never one message with many recipients.
 *
 * That is a deliberate constraint, not an implementation detail. Every recipient gets their
 * own envelope with only their address on it, so nobody learns who else was contacted, and
 * each body is the one composed for that person. The tool has no way to express a
 * merge-field blast, which is the shape the evidence says gets deleted.
 */
/**
 * Port 587 with STARTTLS rather than 465 with implicit TLS.
 *
 * Both reach Gmail. 587 is chosen because this runs in a Vercel serverless function, where
 * 465 is the likelier of the two to stall: implicit TLS opens the handshake immediately on
 * connect, and a cold Lambda with a slow first packet has nothing to fall back on. 587
 * completes a plaintext greeting first and upgrades after, which fails faster and more
 * legibly when the network is the problem.
 *
 * `requireTLS` is the load-bearing line and not a default. With `secure: false`, nodemailer
 * ATTEMPTS STARTTLS but will proceed unencrypted if the server does not advertise it — which
 * on a hostile or misconfigured path would put the app password on the wire in the clear.
 * `requireTLS: true` turns that fallback into a failure. Never send this credential
 * unencrypted; a bounced email is recoverable and a leaked password is not.
 *
 * The timeouts exist for the same serverless reason: without them a stalled connection hangs
 * until the platform kills the function, which surfaces to the user as nothing at all rather
 * than as an error they can act on.
 */
export const SMTP = {
  host: 'smtp.gmail.com',
  port: 587,
  secure: false,
  requireTLS: true,
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

export const MAX_BATCH = 10;

/**
 * Gmail's own ceiling is ~500 recipients a day on a personal account, and sustained cold
 * volume is what gets an account restricted rather than any single message. This cap is far
 * below that on purpose: it bounds a stuck loop, and it is a reminder that the bottleneck
 * here was never typing speed.
 */
export async function sendAll(messages: Outgoing[]): Promise<{ sent: number; failed: { to: string; reason: string }[] }> {
  const creds = credentials();
  if (!creds) throw new Error('gmail credentials are not configured');
  if (messages.length > MAX_BATCH) throw new Error(`at most ${MAX_BATCH} messages at a time`);

  const transport = nodemailer.createTransport({ ...SMTP, auth: { user: creds.user, pass: creds.pass } });

  const failed: { to: string; reason: string }[] = [];
  let sent = 0;
  // Serial, not Promise.all: one authenticated SMTP connection, and a partial failure has to
  // report WHICH recipients missed out rather than collapsing into one rejected promise.
  for (const message of messages) {
    try {
      await transport.sendMail({
        from: creds.user,
        to: message.to,
        subject: message.subject,
        text: message.body,
      });
      sent += 1;
    } catch (error) {
      failed.push({ to: message.to, reason: (error as Error).message.slice(0, 200) });
    }
  }
  transport.close();
  return { sent, failed };
}
