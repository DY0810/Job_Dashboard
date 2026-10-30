/**
 * Put the one fixture role into the STAGING catalog database, so a staging run has something to apply to.
 *
 *   TURSO_DATABASE_URL=<staging url> TURSO_AUTH_TOKEN=<staging token> node scripts/staging-seed.ts
 *
 * It refuses any database whose URL does not name `workie-staging`, so it can never write production.
 * The role's Greenhouse page is never fetched: the worker serves it itself (worker/ats/greenhouse-fixture.ts),
 * and only this tenant may be submitted outside production (lib/applications/submissions.ts).
 */
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { postings } from '../lib/db/schema.ts';
import { STAGING_FIXTURE_TENANT } from '../lib/applications/worker-protocol.ts';

const url = process.env.TURSO_DATABASE_URL ?? '';
if (!/^(https|libsql):\/\/workie-staging-[a-z0-9]+\.[a-z0-9.-]+\.turso\.io$/.test(url)) throw new Error('Not a staging catalog database URL.');
const client = createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN });
const now = new Date();
// Plain wording on purpose: no degree, major, term or work-authorization text, which would make the worker ask first.
const description = 'Fixture Co is hiring a Software Engineering Intern to build TypeScript APIs, write CI tests and improve reliability. ' +
  'This is the Workie staging fixture role; its form is served by the worker and never reaches an employer.';
const row = {
  dedupeKey: `staging-fixture-${STAGING_FIXTURE_TENANT}-4000001`,
  canonicalUrl: `https://job-boards.greenhouse.io/${STAGING_FIXTURE_TENANT}/jobs/4000001`,
  // Discovery only offers roles first seen in the last 60 days, so each seed refreshes the dates.
  postedAt: now, firstSeenRun: now.toISOString(), delistedAt: null, delistedReason: null,
  company: 'Fixture Co', title: 'Software Engineering Intern', description,
  companyNorm: 'fixture co', titleNorm: 'software engineering intern', locationKey: 'remote',
  country: 'US', isRemote: true, location: 'Remote', workMode: 'remote' as const,
  track: 'engineering' as const, seniority: 'entry' as const, employmentType: 'internship' as const, paid: true,
};
try {
  const db = drizzle(client);
  const { dedupeKey: _key, ...update } = row;
  await db.insert(postings).values(row).onConflictDoUpdate({ target: postings.dedupeKey, set: update });
  console.log(`Staging fixture role ready: ${row.canonicalUrl}`);
} finally {
  client.close();
}
