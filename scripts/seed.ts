/**
 * Fixture postings, so the table can be exercised before the connectors land.
 *
 * `npm run seed` — migrates `worky.db` (or `$WORKY_DB`) and replaces its `postings` rows.
 *
 * This file is also the corpus for `lib/query.test.ts`: the adversarial sort cases the two
 * tabs disagree about live here once, not twice. Normalized columns are written literally
 * rather than run through `lib/normalize.ts` on purpose — a fixture should state what it is
 * testing, and a normalizer change must not silently re-aim the sort assertions.
 *
 * Standalone node script: relative imports carry their `.ts` extension because Node's
 * type-stripping does not rewrite specifiers.
 */

import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { postings } from '../lib/db/schema.ts';

type Track = 'design' | 'engineering';
type Seniority = 'entry' | 'junior' | 'mid' | 'senior+';
type Employment = 'full-time' | 'part-time' | 'contract' | 'freelance' | 'internship';
type Season = 'summer' | 'fall' | 'winter' | 'spring';
type Mode = 'remote' | 'hybrid' | 'onsite';
type Period = 'hour' | 'week' | 'month' | 'year';

/** The four places that matter to `GEO_TIER`: metro, other-California, remote, elsewhere. */
const PLACES = {
  sf: { location: 'San Francisco, CA', cityNorm: 'sf', state: 'CA', country: 'US', isRemote: false },
  nyc: { location: 'New York, NY', cityNorm: 'nyc', state: 'NY', country: 'US', isRemote: false },
  oakland: { location: 'Oakland, CA', cityNorm: 'oakland', state: 'CA', country: 'US', isRemote: false },
  berlin: { location: 'Berlin, Germany', cityNorm: 'berlin', state: null, country: 'DE', isRemote: false },
  austin: { location: 'Austin, TX', cityNorm: 'austin', state: 'TX', country: 'US', isRemote: false },
  remote: { location: 'Remote', cityNorm: null, state: null, country: null, isRemote: true },
} as const;

/** Marks a row as fixture data. The seed deletes by this and nothing else. */
const SEED_RUN = 'seed';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

interface Fixture {
  /** Stable handle. Also the dedupe key seed and the lookup key in the tests. */
  ref: string;
  track: Track;
  company: string;
  title: string;
  place: keyof typeof PLACES;
  /** Age at seed time. */
  age: number;
  seniority: Seniority;
  type: Employment;
  mode: Mode;
  /** true | false | null, where null is "the posting does not say" (finding G). */
  paid: boolean | null;
  season?: Season;
  pay?: [number, number, Period];
  grad?: string;
  summary?: string;
  badges?: string[];
  detail?: boolean;
  delisted?: boolean;
}

const FIXTURES: Fixture[] = [
  // ── Design: the four-key sort, and the two cases a three-key sort gets wrong ──────────
  { ref: 'd-sf-3d', track: 'design', company: 'Northline', title: 'Product Designer', place: 'sf', age: 3 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, pay: [85_000, 110_000, 'year'], detail: true },
  { ref: 'd-berlin-3d', track: 'design', company: 'Kestrel Systems', title: 'Product Designer', place: 'berlin', age: 3 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, pay: [62_000, 78_000, 'year'] },
  { ref: 'd-berlin-2h', track: 'design', company: 'Kestrel Systems', title: 'Brand Designer', place: 'berlin', age: 2 * HOUR, seniority: 'junior', type: 'full-time', mode: 'hybrid', paid: true, pay: [58_000, 72_000, 'year'] },
  // Identical through key 3, so only seniority separates them. Seeded mid-first on purpose:
  // insertion order is the wrong answer, so the tie-break has to be doing the work.
  { ref: 'd-tie-mid', track: 'design', company: 'Barrow & Field', title: 'Visual Designer', place: 'sf', age: 5 * DAY, seniority: 'mid', type: 'full-time', mode: 'hybrid', paid: true, pay: [110_000, 135_000, 'year'] },
  { ref: 'd-tie-entry', track: 'design', company: 'Halcyon Type', title: 'Visual Designer', place: 'sf', age: 5 * DAY, seniority: 'entry', type: 'full-time', mode: 'hybrid', paid: true, pay: [72_000, 88_000, 'year'] },
  // Must never render, under any filter combination.
  { ref: 'd-senior', track: 'design', company: 'Northline', title: 'Design Lead', place: 'sf', age: 1 * DAY, seniority: 'senior+', type: 'full-time', mode: 'onsite', paid: true, pay: [180_000, 210_000, 'year'] },
  { ref: 'd-old', track: 'design', company: 'Meridian Post', title: 'Product Designer', place: 'sf', age: 61 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true },
  { ref: 'd-delisted', track: 'design', company: 'Northline', title: 'UX Designer', place: 'sf', age: 1 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, delisted: true },
  // Pay unknown: neither chip matches it, but it is visible with no chip on.
  { ref: 'd-unknown-pay', track: 'design', company: 'Fathom Interactive', title: 'Motion Designer', place: 'remote', age: 6 * HOUR, seniority: 'junior', type: 'freelance', mode: 'remote', paid: null },
  { ref: 'd-unpaid-intern', track: 'design', company: 'Cadence Union', title: 'Design Intern', place: 'nyc', age: 2 * DAY, seniority: 'entry', type: 'internship', mode: 'onsite', paid: false },
  { ref: 'd-parttime', track: 'design', company: 'Ridgeline Print', title: 'Packaging Designer', place: 'oakland', age: 4 * DAY, seniority: 'junior', type: 'part-time', mode: 'hybrid', paid: true, pay: [38, 46, 'hour'] },
  { ref: 'd-remote-mid', track: 'design', company: 'Solder Studio', title: 'Design Systems Designer', place: 'remote', age: 9 * HOUR, seniority: 'mid', type: 'full-time', mode: 'remote', paid: true, pay: [125_000, 150_000, 'year'], badges: ['design-systems'] },
  { ref: 'd-freelance', track: 'design', company: 'Aperture Weekly', title: 'Editorial Designer', place: 'remote', age: 11 * DAY, seniority: 'junior', type: 'freelance', mode: 'remote', paid: true, pay: [55, 70, 'hour'] },
  { ref: 'd-austin', track: 'design', company: 'Pilot Grove', title: 'Product Designer', place: 'austin', age: 16 * HOUR, seniority: 'junior', type: 'full-time', mode: 'hybrid', paid: true, pay: [92_000, 112_000, 'year'] },
  { ref: 'd-sparse', track: 'design', company: 'Quarry Works', title: 'Communication Designer', place: 'remote', age: 21 * DAY, seniority: 'junior', type: 'full-time', mode: 'remote', paid: null },
  { ref: 'd-nyc-mid', track: 'design', company: 'Cadence Union', title: 'Interaction Designer', place: 'nyc', age: 6 * DAY, seniority: 'mid', type: 'full-time', mode: 'onsite', paid: true, pay: [118_000, 140_000, 'year'] },
  { ref: 'd-oakland-entry', track: 'design', company: 'Ridgeline Print', title: 'Junior Product Designer', place: 'oakland', age: 13 * DAY, seniority: 'entry', type: 'full-time', mode: 'onsite', paid: true, pay: [78_000, 92_000, 'year'] },

  // ── Engineering: same shapes, no geo weighting ────────────────────────────────────────
  { ref: 'e-sf-3d', track: 'engineering', company: 'Northline', title: 'Frontend Engineer', place: 'sf', age: 3 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, pay: [140_000, 165_000, 'year'], summary: 'React and TypeScript on the customer dashboard, alongside two senior engineers.', detail: true },
  { ref: 'e-berlin-3d', track: 'engineering', company: 'Kestrel Systems', title: 'Frontend Engineer', place: 'berlin', age: 3 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, pay: [68_000, 82_000, 'year'], summary: 'Component library work for a logistics console used by dispatchers.' },
  { ref: 'e-tie-mid', track: 'engineering', company: 'Barrow & Field', title: 'Backend Engineer', place: 'sf', age: 5 * DAY, seniority: 'mid', type: 'full-time', mode: 'hybrid', paid: true, pay: [165_000, 190_000, 'year'], summary: 'Postgres-heavy billing work; you will be the third engineer on the team.' },
  { ref: 'e-tie-entry', track: 'engineering', company: 'Halcyon Type', title: 'Backend Engineer', place: 'sf', age: 5 * DAY, seniority: 'entry', type: 'full-time', mode: 'hybrid', paid: true, pay: [130_000, 150_000, 'year'], summary: 'Go services behind a font licensing API. Owns one service by month three.' },
  { ref: 'e-senior', track: 'engineering', company: 'Northline', title: 'Staff Engineer, Platform', place: 'sf', age: 1 * DAY, seniority: 'senior+', type: 'full-time', mode: 'onsite', paid: true, pay: [230_000, 270_000, 'year'], summary: 'Owns the deployment platform end to end.' },
  { ref: 'e-old', track: 'engineering', company: 'Meridian Post', title: 'Software Engineer', place: 'sf', age: 61 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, summary: 'General product work across a Rails monolith.' },
  { ref: 'e-delisted', track: 'engineering', company: 'Solder Studio', title: 'Platform Engineer', place: 'remote', age: 2 * DAY, seniority: 'mid', type: 'full-time', mode: 'remote', paid: true, delisted: true, summary: 'Kubernetes and Terraform for a four-region deployment.' },
  { ref: 'e-voice', track: 'engineering', company: 'Tessellate Audio', title: 'Member of Technical Staff', place: 'sf', age: 3 * HOUR, seniority: 'junior', type: 'full-time', mode: 'hybrid', paid: true, pay: [155_000, 185_000, 'year'], badges: ['voice-ai'], summary: 'Turn detection and barge-in for a realtime voice agent stack.', detail: true },
  { ref: 'e-intern-summer', track: 'engineering', company: 'Pilot Grove', title: 'Software Engineering Intern', place: 'sf', age: 5 * HOUR, seniority: 'entry', type: 'internship', mode: 'onsite', paid: true, season: 'summer', pay: [45, 52, 'hour'], grad: 'Dec 2027', summary: 'Twelve weeks on the ingestion pipeline, with a named mentor.' },
  { ref: 'e-intern-fall', track: 'engineering', company: 'Cadence Union', title: 'Backend Intern', place: 'nyc', age: 20 * HOUR, seniority: 'entry', type: 'internship', mode: 'hybrid', paid: false, season: 'fall', grad: 'May 2027', summary: 'Course-credit placement on an internal reporting service.' },
  { ref: 'e-intern-winter', track: 'engineering', company: 'Quarry Works', title: 'Infrastructure Intern', place: 'remote', age: 26 * HOUR, seniority: 'entry', type: 'internship', mode: 'remote', paid: true, season: 'winter', pay: [40, 40, 'hour'], grad: 'Jun 2028', summary: 'Build and release tooling over the winter term.' },
  { ref: 'e-intern-spring', track: 'engineering', company: 'Fathom Interactive', title: 'Frontend Intern', place: 'remote', age: 8 * DAY, seniority: 'entry', type: 'internship', mode: 'remote', paid: null, season: 'spring', grad: 'Dec 2026', summary: 'Design-systems work in a Next.js app; stipend not stated.' },
  { ref: 'e-unknown-pay', track: 'engineering', company: 'Aperture Weekly', title: 'Full Stack Engineer', place: 'remote', age: 40 * HOUR, seniority: 'junior', type: 'full-time', mode: 'remote', paid: null, summary: 'Small team, Django and htmx, no compensation range published.' },
  { ref: 'e-remote-mid', track: 'engineering', company: 'Solder Studio', title: 'Systems Engineer', place: 'remote', age: 12 * HOUR, seniority: 'mid', type: 'full-time', mode: 'remote', paid: true, pay: [150_000, 175_000, 'year'], summary: 'Rust data plane for an edge cache. Async and profiling heavy.' },
  { ref: 'e-oakland', track: 'engineering', company: 'Ridgeline Print', title: 'Application Engineer', place: 'oakland', age: 2 * DAY, seniority: 'junior', type: 'full-time', mode: 'hybrid', paid: true, pay: [128_000, 145_000, 'year'], summary: 'Internal tools for a print operation: scheduling, proofs, and inventory.' },
  { ref: 'e-austin', track: 'engineering', company: 'Pilot Grove', title: 'Data Engineer', place: 'austin', age: 30 * HOUR, seniority: 'junior', type: 'full-time', mode: 'hybrid', paid: true, pay: [120_000, 140_000, 'year'], summary: 'dbt and Airflow over a warehouse that four analysts depend on.' },
  { ref: 'e-nyc-entry', track: 'engineering', company: 'Cadence Union', title: 'Software Engineer I', place: 'nyc', age: 4 * DAY, seniority: 'entry', type: 'full-time', mode: 'onsite', paid: true, pay: [125_000, 140_000, 'year'], summary: 'New-grad track on a subscription billing product.' },
  { ref: 'e-berlin-remote', track: 'engineering', company: 'Kestrel Systems', title: 'Backend Engineer, Fleet', place: 'berlin', age: 7 * DAY, seniority: 'mid', type: 'full-time', mode: 'remote', paid: true, pay: [75_000, 92_000, 'year'], summary: 'Telemetry ingestion for a European fleet-tracking product.' },
  { ref: 'e-sf-hybrid', track: 'engineering', company: 'Halcyon Type', title: 'Rendering Engineer', place: 'sf', age: 9 * DAY, seniority: 'mid', type: 'full-time', mode: 'hybrid', paid: true, pay: [170_000, 200_000, 'year'], summary: 'Glyph rasterization and hinting in a browser-based type editor.' },
  { ref: 'e-voice-remote', track: 'engineering', company: 'Tessellate Audio', title: 'Speech Infrastructure Engineer', place: 'remote', age: 14 * DAY, seniority: 'mid', type: 'full-time', mode: 'remote', paid: true, pay: [160_000, 195_000, 'year'], badges: ['voice-ai'], summary: 'Streaming ASR endpoints, endpointing latency, and model rollout.' },
  { ref: 'e-sparse', track: 'engineering', company: 'Quarry Works', title: 'Software Engineer', place: 'remote', age: 24 * DAY, seniority: 'junior', type: 'full-time', mode: 'remote', paid: null },
  { ref: 'e-nyc-junior', track: 'engineering', company: 'Barrow & Field', title: 'Product Engineer', place: 'nyc', age: 17 * DAY, seniority: 'junior', type: 'full-time', mode: 'onsite', paid: true, pay: [135_000, 155_000, 'year'], summary: 'Ships user-facing features weekly against a Next.js and Postgres stack.' },
  { ref: 'e-austin-mid', track: 'engineering', company: 'Meridian Post', title: 'Site Reliability Engineer', place: 'austin', age: 33 * DAY, seniority: 'mid', type: 'full-time', mode: 'onsite', paid: true, pay: [145_000, 168_000, 'year'], summary: 'On-call rotation of six, and the runbooks that keep it quiet.' },
  { ref: 'e-oakland-entry', track: 'engineering', company: 'Ridgeline Print', title: 'Junior Software Engineer', place: 'oakland', age: 44 * DAY, seniority: 'entry', type: 'full-time', mode: 'hybrid', paid: true, pay: [110_000, 125_000, 'year'], summary: 'Maintains the order pipeline; pairs with the lead two afternoons a week.' },
];

const DETAIL = {
  description:
    'We are a team of eleven, and this role reports to the head of product. You will own a surface end to end — research, interface, and the code that ships it — and you will see the result in production within your first month. We review work together every Thursday, and we do not ship on Fridays.',
  responsibilities: [
    'Own one product surface from research through shipped code',
    'Run a weekly design review with two engineers and the product lead',
    'Keep the component library current as the surface changes',
  ],
  skills: [
    'Two or more years building production interfaces',
    'Comfortable in a typed codebase; you do not need to be the strongest engineer in the room',
    'A portfolio that shows the reasoning, not only the outcome',
  ],
  education: [
    'No degree requirement',
    'Bootcamp, self-taught, and non-traditional paths all considered',
  ],
};

/** `dedupe_key` for a fixture. Exported so tests can map a row id back to its `ref`. */
export function refKey(ref: string): string {
  return createHash('sha256').update(`seed:${ref}`).digest('hex');
}

/** Fixture handles, in insertion order. */
export const REFS: readonly string[] = FIXTURES.map((f) => f.ref);

function build(f: Fixture, now: number) {
  const place = PLACES[f.place];
  const slug = f.ref.replace(/^[de]-/, '');
  return {
    // Seed rows are not ingest rows: the key only needs to be unique and stable, and the
    // `seed:` prefix makes it obvious in the database that no connector produced this.
    dedupeKey: refKey(f.ref),
    canonicalUrl: `https://jobs.example.com/${f.company.toLowerCase().replace(/[^a-z]+/g, '-')}/${slug}`,
    postedAt: new Date(now - f.age),
    delistedAt: f.delisted ? new Date(now - f.age + 3600_000) : null,
    firstSeenRun: SEED_RUN,
    company: f.company,
    title: f.title,
    description: f.detail ? DETAIL.description : null,
    companyNorm: f.company.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    titleNorm: f.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(),
    locationKey: place.isRemote ? 'remote' : `onsite|${place.cityNorm}|${place.state ?? ''}|${place.country ?? ''}`,
    cityNorm: place.cityNorm,
    state: place.state,
    country: place.country,
    isRemote: place.isRemote,
    enrichedAt: new Date(now - f.age + 60_000),
    track: f.track,
    seniority: f.seniority,
    employmentType: f.type,
    internshipSeason: f.season ?? null,
    paid: f.paid,
    workMode: f.mode,
    location: place.location,
    payRateMin: f.pay?.[0] ?? null,
    payRateMax: f.pay?.[1] ?? null,
    payRatePeriod: f.pay?.[2] ?? null,
    expectedGrad: f.grad ?? null,
    summary: f.summary ?? null,
    responsibilities: f.detail ? DETAIL.responsibilities : null,
    skills: f.detail ? DETAIL.skills : null,
    education: f.detail ? DETAIL.education : null,
    badges: f.badges ?? null,
  };
}

/** Every fixture as an insertable row. `now` is injected so tests get deterministic ages. */
export function fixtures(now: number) {
  const rows = FIXTURES.map((f) => build(f, now));
  const keys = new Set(rows.map((r) => r.dedupeKey));
  if (keys.size !== rows.length) throw new Error('seed: duplicate dedupe_key');
  return rows;
}

if (process.argv[1]?.endsWith('seed.ts')) {
  const path = process.env.WORKY_DB ?? 'worky.db';
  const db = drizzle(new Database(path));
  // Idempotent: drizzle's own migrator tracks what it has applied, so seeding twice is fine.
  migrate(db, { migrationsFolder: 'drizzle' });
  // Only ever deletes its own rows. The empty state points people here, and a real corpus
  // (with its absence-count history) must survive someone taking that advice.
  db.delete(postings).where(eq(postings.firstSeenRun, SEED_RUN)).run();
  const rows = fixtures(Date.now());
  db.insert(postings).values(rows).run();
  console.log(`seed: ${rows.length} postings into ${path}`);
}
