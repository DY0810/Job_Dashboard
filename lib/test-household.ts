import { vi } from 'vitest';
import { householdSessionCookie, readHouseholdConfig, resolveHouseholdApplicant, type HouseholdProfileId } from './household-auth.ts';
import type { PrivateDb } from './private-db/index.ts';

/** Test helper: household PIN mode, the only applicant auth, with two synthetic profiles. */
export function stubHousehold(origin = 'https://workie.example.test', dy = 'alice@example.test', may = 'bob@example.test') {
  vi.stubEnv('VERCEL', '');
  vi.stubEnv('BETTER_AUTH_URL', origin);
  vi.stubEnv('BETTER_AUTH_SECRET', 'synthetic-household-secret-'.padEnd(64, 'x'));
  vi.stubEnv('WORKIE_HOUSEHOLD_PASSCODE', '2468');
  vi.stubEnv('WORKIE_HOUSEHOLD_DY_EMAIL', dy);
  vi.stubEnv('WORKIE_HOUSEHOLD_MAY_EMAIL', may);
}

/** A signed-in household profile: its ownerId and the request Cookie header. */
export async function householdApplicant(db: PrivateDb, profile: HouseholdProfileId) {
  const cookie = householdSessionCookie(readHouseholdConfig(), profile).split(';')[0];
  return { id: (await resolveHouseholdApplicant(new Headers({ cookie }), db)).ownerId, cookie };
}
