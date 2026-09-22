import 'server-only';

import { createHmac, timingSafeEqual } from 'node:crypto';
import { inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { getPrivateDb, type PrivateDb } from '@/lib/private-db';
import { rateLimit, user } from '@/lib/private-db/schema';

const profileId = z.enum(['dy', 'may']);
export type HouseholdProfileId = z.infer<typeof profileId>;
const SESSION_SECONDS = 30 * 24 * 60 * 60;

export class HouseholdAuthError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type HouseholdConfig = {
  origin: string;
  secret: string;
  passcode: string;
  profiles: Record<HouseholdProfileId, { email: string; name: string; fallbackOwnerId: string }>;
};

export function householdAuthConfigured(env: Record<string, string | undefined> = process.env) {
  return Boolean(env.WORKIE_HOUSEHOLD_PASSCODE?.trim());
}

export function readHouseholdConfig(env: Record<string, string | undefined> = process.env): HouseholdConfig {
  const secret = env.BETTER_AUTH_SECRET?.trim() ?? '';
  const passcode = env.WORKIE_HOUSEHOLD_PASSCODE?.trim() ?? '';
  const dyEmail = env.WORKIE_HOUSEHOLD_DY_EMAIL?.trim().toLowerCase() ?? '';
  const mayEmail = env.WORKIE_HOUSEHOLD_MAY_EMAIL?.trim().toLowerCase() ?? '';
  try {
    const url = new URL(env.BETTER_AUTH_URL ?? '');
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (
      secret.length < 32 || !/^\d{4}$/.test(passcode) ||
      !z.email().safeParse(dyEmail).success || !z.email().safeParse(mayEmail).success || dyEmail === mayEmail ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/' ||
      (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && !env.VERCEL))
    ) throw new Error();
    return {
      origin: url.origin,
      secret,
      passcode,
      profiles: {
        dy: { email: dyEmail, name: 'DY', fallbackOwnerId: 'household-dy-v1' },
        may: { email: mayEmail, name: 'May', fallbackOwnerId: 'household-may-v1' },
      },
    };
  } catch {
    throw new HouseholdAuthError(503, 'Household access is unavailable.');
  }
}

function cookieName(config: HouseholdConfig) {
  return config.origin.startsWith('https:') ? '__Host-workie.household' : 'workie.household';
}

function signature(config: HouseholdConfig, value: string) {
  return createHmac('sha256', config.secret).update(value).digest('base64url');
}

function sameSecret(a: string, b: string, key: string) {
  const left = createHmac('sha256', key).update(a).digest();
  const right = createHmac('sha256', key).update(b).digest();
  return timingSafeEqual(left, right);
}

function sessionToken(config: HouseholdConfig, profile: HouseholdProfileId, now = Date.now()) {
  const value = `${profile}.${Math.floor(now / 1000) + SESSION_SECONDS}`;
  return `${value}.${signature(config, value)}`;
}

function cookieValue(request: Request | Headers, config: HouseholdConfig) {
  const headers = request instanceof Request ? request.headers : request;
  const name = cookieName(config);
  for (const part of (headers.get('cookie') ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return null;
}

export function readHouseholdSession(request: Request | Headers, config = readHouseholdConfig(), now = Date.now()) {
  const token = cookieValue(request, config);
  if (!token) return null;
  const [rawProfile, rawExpiry, rawSignature, extra] = token.split('.');
  const parsedProfile = profileId.safeParse(rawProfile);
  const expiry = Number(rawExpiry);
  if (!parsedProfile.success || extra !== undefined || !Number.isSafeInteger(expiry) || expiry <= Math.floor(now / 1000)) return null;
  const value = `${parsedProfile.data}.${expiry}`;
  const expected = signature(config, value);
  const actual = Buffer.from(rawSignature ?? '');
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted) ? parsedProfile.data : null;
}

export function householdSessionCookie(config: HouseholdConfig, profile: HouseholdProfileId, now = Date.now()) {
  const secure = config.origin.startsWith('https:') ? '; Secure' : '';
  return `${cookieName(config)}=${sessionToken(config, profile, now)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure}`;
}

export function clearHouseholdSessionCookie(config = readHouseholdConfig()) {
  const secure = config.origin.startsWith('https:') ? '; Secure' : '';
  return `${cookieName(config)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`;
}

async function applicants(db: PrivateDb, config: HouseholdConfig) {
  const configured = Object.entries(config.profiles) as [HouseholdProfileId, HouseholdConfig['profiles'][HouseholdProfileId]][];
  const emails = configured.map(([, item]) => item.email);
  let stored = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.email, emails));
  for (const [, item] of configured) {
    if (stored.some((row) => row.email === item.email)) continue;
    await db.insert(user).values({ id: item.fallbackOwnerId, email: item.email, name: item.name, emailVerified: true })
      .onConflictDoNothing({ target: user.email });
  }
  stored = await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.email, emails));
  return configured.map(([id, item]) => {
    const row = stored.find((candidate) => candidate.email === item.email);
    if (!row) throw new HouseholdAuthError(503, 'Household access is unavailable.');
    return { id, ownerId: row.id, email: row.email, name: item.name };
  });
}

export async function resolveHouseholdApplicant(request: Request | Headers, db = getPrivateDb(), config = readHouseholdConfig()) {
  const active = readHouseholdSession(request, config);
  if (!active) throw new HouseholdAuthError(401, 'Passcode required.');
  const applicant = (await applicants(db, config)).find((item) => item.id === active);
  if (!applicant) throw new HouseholdAuthError(503, 'Household access is unavailable.');
  return { ownerId: applicant.ownerId, email: applicant.email, name: applicant.name };
}

export async function listHouseholdApplicants(request: Request, db = getPrivateDb(), config = readHouseholdConfig()) {
  const active = readHouseholdSession(request, config);
  if (!active) throw new HouseholdAuthError(401, 'Passcode required.');
  return (await applicants(db, config)).map((item) => ({
    ownerId: item.ownerId, email: item.email, name: item.name, active: item.id === active,
  }));
}

export async function switchHouseholdApplicant(request: Request, ownerId: string, db = getPrivateDb(), config = readHouseholdConfig()) {
  if (!readHouseholdSession(request, config)) throw new HouseholdAuthError(401, 'Passcode required.');
  const target = (await applicants(db, config)).find((item) => item.ownerId === ownerId);
  if (!target) throw new HouseholdAuthError(404, 'Applicant profile not found.');
  return { applicant: { ownerId: target.ownerId, email: target.email, name: target.name }, cookie: householdSessionCookie(config, target.id) };
}

async function failedAttempt(request: Request, db: PrivateDb, config: HouseholdConfig, now = Date.now()) {
  const forwarded = process.env.VERCEL ? request.headers.get('x-vercel-forwarded-for')?.split(',')[0]?.trim() : 'local';
  const client = createHmac('sha256', config.secret).update(forwarded || 'unknown').digest('hex');
  async function increment(key: string, windowMs: number, maximum: number) {
    const window = Math.floor(now / windowMs) * windowMs;
    const [row] = await db.insert(rateLimit).values({ id: crypto.randomUUID(), key, count: 1, lastRequest: window })
      .onConflictDoUpdate({
        target: rateLimit.key,
        set: {
          count: sql`case when ${rateLimit.lastRequest} < ${window} then 1 else ${rateLimit.count} + 1 end`,
          lastRequest: sql`case when ${rateLimit.lastRequest} < ${window} then ${window} else ${rateLimit.lastRequest} end`,
        },
      }).returning({ count: rateLimit.count });
    return row.count <= maximum;
  }
  const local = await increment(`household-pin:ip:${client}`, 15 * 60_000, 5);
  const global = await increment('household-pin:global', 24 * 60 * 60_000, 25);
  return local && global;
}

export async function unlockHousehold(request: Request, passcode: string, requested: HouseholdProfileId, db = getPrivateDb(), config = readHouseholdConfig()) {
  if (!sameSecret(passcode, config.passcode, config.secret)) {
    const allowed = await failedAttempt(request, db, config);
    throw new HouseholdAuthError(allowed ? 401 : 429, allowed ? 'Incorrect passcode.' : 'Too many attempts. Try again later.');
  }
  const target = (await applicants(db, config)).find((item) => item.id === requested);
  if (!target) throw new HouseholdAuthError(503, 'Household access is unavailable.');
  return { applicant: { ownerId: target.ownerId, email: target.email, name: target.name }, cookie: householdSessionCookie(config, target.id) };
}
