import 'server-only';
import nodemailer from 'nodemailer';
import { z } from 'zod';

import { accountFor, SMTP } from '@/lib/send';

export type AuthMail = { kind: 'verification' | 'reset'; to: string; url: string };
export type AuthMailSink = (message: AuthMail) => Promise<void>;

export function createAuthMailSink(from: string): AuthMailSink {
  // accountFor(undefined) chooses the outreach default. Auth must NEVER take that path.
  if (!z.email().safeParse(from).success) throw new Error('Authentication mail is unavailable.');
  const account = accountFor(from);
  if (!account) throw new Error('Authentication mail is unavailable.');
  return async ({ kind, to, url }) => {
    const transport = nodemailer.createTransport({ ...SMTP, auth: account });
    try {
      await transport.sendMail({
        from: account.user,
        to,
        subject: kind === 'verification' ? 'Verify your Workie email' : 'Reset your Workie password',
        text: `${kind === 'verification' ? 'Verify your email' : 'Reset your password'}:\n\n${url}\n\nIf you did not request this, ignore this email.`,
        disableFileAccess: true,
        disableUrlAccess: true,
      });
    } catch {
      throw new Error('Authentication email delivery failed.');
    } finally {
      transport.close();
    }
  };
}
