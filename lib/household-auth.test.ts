import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HouseholdAuthError,
  householdSessionCookie,
  listHouseholdApplicants,
  readHouseholdConfig,
  resolveHouseholdApplicant,
  switchHouseholdApplicant,
  unlockHousehold,
  type HouseholdConfig,
} from '@/lib/household-auth';
import { migratePrivateDb, openPrivateDb, type PrivateDb } from '@/lib/private-db';
import { rateLimit } from '@/lib/private-db/schema';

vi.mock('server-only', () => ({}));

const origin = 'https://workie.example.test';
let directory: string;
let db: PrivateDb;
let config: HouseholdConfig;

function request(cookie = '') {
  return new Request(`${origin}/api/auth/household`, {
    method: cookie ? 'GET' : 'POST',
    headers: { origin, ...(cookie ? { cookie } : {}) },
  });
}

function cookieHeader(value: string) {
  return value.split(';')[0];
}

beforeEach(async () => {
  vi.stubEnv('VERCEL', '');
  directory = mkdtempSync(join(process.cwd(), 'logs/auto-apply-gate/household-'));
  db = openPrivateDb({ url: `file:${join(directory, 'private.db')}` });
  await migratePrivateDb(db);
  config = readHouseholdConfig({
    BETTER_AUTH_URL: origin,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    WORKIE_HOUSEHOLD_PASSCODE: '2468',
    WORKIE_HOUSEHOLD_DY_EMAIL: 'dy@example.test',
    WORKIE_HOUSEHOLD_MAY_EMAIL: 'may@example.test',
  });
});

afterEach(() => {
  db?.$client.close();
  if (directory) rmSync(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

describe('household access', () => {
  it('unlocks either isolated applicant, signs the cookie, and switches without accepting owner forgery', async () => {
    const unlocked = await unlockHousehold(request(), '2468', 'dy', db, config);
    expect(unlocked.applicant).toMatchObject({ ownerId: 'household-dy-v1', name: 'DY', email: 'dy@example.test' });
    expect(unlocked.cookie).toContain('HttpOnly');
    expect(unlocked.cookie).toContain('Secure');
    expect(unlocked.cookie).toContain('SameSite=Lax');
    const dyRequest = request(cookieHeader(unlocked.cookie));
    expect(await resolveHouseholdApplicant(dyRequest, db, config)).toEqual(unlocked.applicant);
    const listed = await listHouseholdApplicants(dyRequest, db, config);
    expect(listed).toEqual([
      { ownerId: 'household-dy-v1', email: 'dy@example.test', name: 'DY', active: true },
      { ownerId: 'household-may-v1', email: 'may@example.test', name: 'May', active: false },
    ]);
    await expect(switchHouseholdApplicant(dyRequest, 'forged-owner', db, config)).rejects.toMatchObject({ status: 404 });
    const switched = await switchHouseholdApplicant(dyRequest, 'household-may-v1', db, config);
    expect(await resolveHouseholdApplicant(request(cookieHeader(switched.cookie)), db, config)).toEqual(switched.applicant);
    const tampered = cookieHeader(switched.cookie).replace('may.', 'dy.');
    await expect(resolveHouseholdApplicant(request(tampered), db, config)).rejects.toMatchObject({ status: 401 });
  });

  it('throttles repeated wrong PINs in the migrated private database', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(unlockHousehold(request(), '0000', 'dy', db, config)).rejects.toMatchObject({ status: 401 });
    }
    await expect(unlockHousehold(request(), '0000', 'dy', db, config)).rejects.toMatchObject({ status: 429 });
    expect(await db.select().from(rateLimit)).toHaveLength(2);
    await expect(unlockHousehold(request(), '2468', 'dy', db, config)).resolves.toMatchObject({ applicant: { name: 'DY' } });
  });

  it('fails closed on missing configuration and expired sessions', async () => {
    expect(() => readHouseholdConfig({ WORKIE_HOUSEHOLD_PASSCODE: '2468' })).toThrow(HouseholdAuthError);
    const expired = householdSessionCookie(config, 'dy', Date.now() - 31 * 24 * 60 * 60_000);
    await expect(resolveHouseholdApplicant(request(cookieHeader(expired)), db, config)).rejects.toMatchObject({ status: 401 });
  });
});
