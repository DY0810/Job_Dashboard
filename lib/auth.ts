import 'server-only';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { multiSession } from 'better-auth/plugins';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import { after } from 'next/server';
import { z } from 'zod';

import { createAuthMailSink, type AuthMailSink } from '@/lib/auth-mail';
import { getPrivateDb, type PrivateDb } from '@/lib/private-db';
import * as schema from '@/lib/private-db/schema';

export class AuthConfigurationError extends Error {
  constructor() {
    super('Applicant authentication is unavailable.');
    this.name = 'AuthConfigurationError';
  }
}

export type AuthConfig = {
  baseURL: string;
  secret: string;
  allowedEmails: string[];
  mailFrom: string;
};

/** Explicit configuration in local and hosted modes; no development auth bypass. */
export function readAuthConfig(env: Record<string, string | undefined> = process.env): AuthConfig {
  const secret = env.BETTER_AUTH_SECRET?.trim();
  const allowedEmails = [...new Set(
    (env.WORKIE_APPLICANT_EMAIL_ALLOWLIST ?? '').split(',').map((s) => s.trim().toLowerCase()),
  )];
  const mailFrom = env.WORKIE_AUTH_MAIL_FROM?.trim().toLowerCase();
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      !secret || secret.length < 32 ||
      !mailFrom || !z.email().safeParse(mailFrom).success ||
      allowedEmails.some((email) => !z.email().safeParse(email).success) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !env.VERCEL))
    ) throw new AuthConfigurationError();
    return { baseURL: url.origin, secret, allowedEmails, mailFrom };
  } catch {
    throw new AuthConfigurationError();
  }
}

type AuthDependencies = {
  sendMail?: AuthMailSink;
  // Tests queue and drain synthetic deliveries; production requires a Next request scope.
  scheduleMail?: (task: () => Promise<void>) => void;
  allowedEmails?: () => readonly string[];
};

export function createAuth(config: AuthConfig, db: PrivateDb, dependencies: AuthDependencies = {}) {
  const sendMail = dependencies.sendMail ?? createAuthMailSink(config.mailFrom);
  const scheduleMail = dependencies.scheduleMail ?? ((task) => after(task));
  const isAllowedApplicant = (email: string) =>
    (dependencies.allowedEmails?.() ?? config.allowedEmails).includes(email.trim().toLowerCase());
  const deliver = (kind: 'verification' | 'reset', email: string, url: string) => {
    // Better Auth 1.7.5 awaits manual resends directly. Schedule INSIDE each callback.
    // Next 15 after() is duration-bound, not a durable outbox or proof of SMTP delivery.
    scheduleMail(async () => {
      if (!isAllowedApplicant(email)) return;
      try {
        await sendMail({ kind, to: email, url });
      } catch {
        // Never hand SMTP errors (which can contain addresses/credentials) to Next's logger.
        throw new Error('Authentication email delivery failed.');
      }
    });
  };
  const auth = betterAuth({
    appName: 'Workie',
    baseURL: config.baseURL,
    secret: config.secret,
    // v1.7.5 defaults transaction to false; private libSQL supports async transactions.
    database: drizzleAdapter(db, { provider: 'sqlite', schema, transaction: true }),
    telemetry: { enabled: false, debug: false },
    experimental: { instrumentation: { enabled: false } },
    logger: { disabled: true },
    trustedOrigins: [config.baseURL],
    advanced: {
      disableOriginCheck: false,
      disableCSRFCheck: false,
      useSecureCookies: config.baseURL.startsWith('https:'),
      cookiePrefix: 'workie',
      defaultCookieAttributes: { httpOnly: true, sameSite: 'lax' },
      // Direct local servers cannot trust caller-supplied forwarding headers. A shared
      // per-path bucket is the safe fallback; Vercel overwrites x-vercel-forwarded-for.
      ipAddress: { ipAddressHeaders: process.env.VERCEL ? ['x-vercel-forwarded-for'] : [] },
    },
    rateLimit: { enabled: true, storage: 'database', window: 60, max: 100 },
    session: { cookieCache: { enabled: false } },
    user: {
      // v1.7.5 returns synthetic signup success for rejection when verification is required.
      validateUserInfo: ({ user }) =>
        typeof user.email === 'string' && isAllowedApplicant(user.email)
          ? undefined
          : { error: 'APPLICANT_NOT_ALLOWED' },
      changeEmail: { enabled: false },
      deleteUser: { enabled: false },
    },
    databaseHooks: {
      session: {
        create: {
          // validateUserInfo does NOT run for returning email/password sign-ins.
          before: async (session) => {
            const [user] = await db.select().from(schema.user).where(eq(schema.user.id, session.userId));
            if (!user?.emailVerified || !isAllowedApplicant(user.email)) {
              throw new APIError('FORBIDDEN', { message: 'Applicant access is not permitted.' });
            }
          },
        },
      },
    },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      revokeSessionsOnPasswordReset: true,
      // No onPasswordReset placeholder: v1.7.5 calls it BEFORE deleting sessions.
      // Phase 3 must implement worker security revocation without blocking this deletion.
      sendResetPassword: async ({ user, token }) => {
        // v1.7.5 documents raw token delivery to a custom route; POST validates it.
        const url = new URL('/sign-in?mode=reset', config.baseURL);
        url.searchParams.set('token', token);
        deliver('reset', user.email, url.href);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }) => deliver('verification', user.email, url),
    },
    plugins: [multiSession({ maximumSessions: 2 })],
  });
  return Object.assign(auth, { isAllowedApplicant, origin: config.baseURL });
}

export type ApplicantAuth = ReturnType<typeof createAuth>;

let cached: { auth: ApplicantAuth; config: AuthConfig; db: PrivateDb } | undefined;

/** Importing public pages/route modules never opens the private database. */
export function getAuth(): ApplicantAuth {
  const config = readAuthConfig();
  const db = getPrivateDb();
  if (cached) {
    if (
      cached.db !== db || cached.config.baseURL !== config.baseURL ||
      cached.config.secret !== config.secret || cached.config.mailFrom !== config.mailFrom
    ) throw new AuthConfigurationError();
    return cached.auth;
  }
  const auth = createAuth(config, db, {
    allowedEmails: () => readAuthConfig().allowedEmails,
  });
  cached = { auth, config, db };
  return auth;
}
