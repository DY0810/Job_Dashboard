/**
 * Tier-1 ATS connectors (plan Phase 3) — greenhouse · lever · ashby · smartrecruiters ·
 * workable · recruitee. `source_priority = 1`: when the same job also arrives from an
 * aggregator, these URLs win the `canonical_url`.
 *
 * Endpoint shapes come from `scripts/ats-probe.js`, which is what confirmed every token in
 * `companies.json` in the first place. Re-deriving them here would let the two drift.
 *
 * WORKDAY IS DEFERRED, not forgotten: `companies.json` has zero Workday tenants, so a
 * Workday connector would iterate an empty list on every run and could not be tested against
 * a real target. `buildRequest('workday', ...)` already holds the POST shape for whenever a
 * Workday company lands in the registry.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseSections,
  type EmploymentType,
  type Section,
  type SourceFields,
  type WorkMode,
} from '../../lib/extract.ts';
import { normalizeDescription } from '../../lib/normalize.ts';
import {
  redact,
  toEpochMs,
  type Connector,
  type ConnectorContext,
  type ConnectorPosting,
} from '../../lib/runtime.ts';
import { buildRequest } from '../ats-probe.js';

export interface RegistryEntry {
  name: string;
  ats: string;
  token: string;
  wdN?: string;
  site?: string;
  tags: string[];
  verified_at: string;
  flagged_at?: string;
}

const REGISTRY_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'companies.json');

let cached: RegistryEntry[] | null = null;

export function registry(): RegistryEntry[] {
  cached ??= JSON.parse(readFileSync(REGISTRY_PATH, 'utf8')) as RegistryEntry[];
  return cached;
}

function endpoint(ats: string, token: string, params: Record<string, string> = {}): string {
  const url = new URL(buildRequest(ats, token, {}).url);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

// ---------------------------------------------------------------------------------------
// Structured fields the ATS already gave us
// ---------------------------------------------------------------------------------------

/**
 * Six vendors, six spellings of the same five values: `FullTime`, `Full-time`,
 * `fulltime_fixed_term`, `Intern`, `Internship`, `PART_TIME`. One normalizer beats six
 * lookup tables, and an unrecognized string returns undefined rather than a guess — the
 * extractor then falls back to the text, which is the whole point of the precedence order.
 */
function employmentTypeFrom(raw: unknown): EmploymentType | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.toLowerCase().replace(/[\s_-]/g, '');
  if (/intern|coop|apprentice|placement/.test(value)) return 'internship';
  if (/parttime/.test(value)) return 'part-time';
  if (/freelance/.test(value)) return 'freelance';
  if (/contract|temporary|temp|fixedterm|seasonal/.test(value)) return 'contract';
  if (/fulltime|permanent|regular/.test(value)) return 'full-time';
  return undefined;
}

/**
 * `isRemote` is only consulted when the vendor gave no workplace type, and only in the
 * positive direction: `isRemote: false` distinguishes nothing between hybrid and onsite.
 */
function workModeFrom(raw: unknown, isRemote?: boolean): WorkMode | undefined {
  const value = typeof raw === 'string' ? raw.toLowerCase().replace(/[\s_-]/g, '') : '';
  if (/hybrid/.test(value)) return 'hybrid';
  if (/remote|anywhere|distributed/.test(value)) return 'remote';
  if (/onsite|inperson|inoffice|office/.test(value)) return 'onsite';
  return isRemote === true ? 'remote' : undefined;
}

/** "Austin, Texas, United States" from whatever parts the source happened to supply. */
function locationFrom(...parts: unknown[]): string | undefined {
  const seen: string[] = [];
  for (const part of parts) {
    const value = typeof part === 'string' ? part.trim() : '';
    if (value && !seen.some((existing) => existing.toLowerCase() === value.toLowerCase())) {
      seen.push(value);
    }
  }
  return seen.length > 0 ? seen.join(', ') : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * Drops the keys the source did not answer, so `source_fields` never stores empty noise.
 *
 * An empty array counts as unanswered. `parseSections` returns `[]` rather than undefined, so
 * every ATS row used to persist at least `{"sections":[]}` — which also made this function
 * effectively never return undefined for an ATS row, contradicting its own contract.
 *
 * `scripts/ingest.ts` uses a truthy `structured` as "an ATS carried fields this run" before
 * overwriting `source_fields`. That guard still holds, and reads more truthfully now: a run
 * that answered nothing no longer counts as having answered.
 */
function sourceFields(fields: SourceFields): SourceFields | undefined {
  const kept = Object.fromEntries(
    Object.entries(fields).filter(
      ([, value]) =>
        value !== undefined && value !== null && !(Array.isArray(value) && value.length === 0),
    ),
  ) as SourceFields;
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/** Every ATS row carries the same fixed fields; only the mapper differs. */
function row(
  source: string,
  entry: RegistryEntry,
  fields: {
    title: unknown;
    location: unknown;
    url: string;
    postedAt: number;
    description: string;
    /** The structured fields THIS vendor returned. `location` here is display-only. */
    structured?: SourceFields;
  },
): ConnectorPosting {
  return {
    source,
    sourceKind: 'ats',
    sourceUrl: fields.url,
    postedAt: fields.postedAt,
    company: entry.name,
    title: typeof fields.title === 'string' ? fields.title : '',
    // NOT the display string below: this one feeds `normalizeLocation` and `dedupe_key`.
    location: typeof fields.location === 'string' ? fields.location : null,
    description: normalizeDescription(fields.description),
    sourceFields: sourceFields(fields.structured ?? {}),
  };
}

type Mapper = (entry: RegistryEntry, context: ConnectorContext) => Promise<ConnectorPosting[]>;

/**
 * One target failing is normal — a company changes its token, a board 500s. One target
 * failing must never cost us the other 45, so each is caught and logged on its own.
 *
 * The connector only fails when EVERY target failed. That distinction matters downstream:
 * ghost detection counts an absence only against an `ok` run, so a connector that quietly
 * returned nothing because every fetch died would otherwise start delisting real postings.
 */
function atsConnector(name: string, map: Mapper): Connector {
  return {
    name,
    kind: 'ats',
    // NO `minIntervalMs`, deliberately. The ATS boards are where a new posting appears
    // FIRST — polling them on every cycle is the entire point of the tool, and the
    // scheduler's own 30-minute interval already is their floor. Declaring 30 minutes here
    // as well would only mean an occasional cycle lands a second early and gets skipped,
    // silently halving the poll rate on the sources that matter most.
    async fetch(context: ConnectorContext): Promise<ConnectorPosting[]> {
      const targets = registry().filter((entry) => entry.ats === name);
      const postings: ConnectorPosting[] = [];
      let failed = 0;

      for (const entry of targets) {
        try {
          postings.push(...(await map(entry, context)));
        } catch (error) {
          failed += 1;
          // We are about to return the other boards' postings and report `ok`. Say so, or the
          // ghost pass reads this board's absent postings as withdrawn and delists them.
          context.degraded(`${entry.name}: fetch failed`);
          context.log({
            connector: name,
            company: entry.name,
            status: 'error',
            error: redact(error instanceof Error ? error.message : String(error)),
          });
        }
      }

      if (targets.length > 0 && failed === targets.length) {
        throw new Error(`all ${targets.length} ${name} targets failed`);
      }
      return postings;
    },
  };
}

interface GreenhouseJob {
  absolute_url?: string;
  title?: string;
  content?: string;
  first_published?: string;
  updated_at?: string;
  location?: { name?: string };
  departments?: { name?: string }[];
  offices?: { name?: string; location?: string }[];
  metadata?: { name?: string; value?: unknown }[];
}

/** Greenhouse's only structured work-mode signal is a board-configured custom field. */
function greenhouseMetadata(job: GreenhouseJob, name: RegExp): string | undefined {
  const field = (job.metadata ?? []).find((entry) => typeof entry.name === 'string' && name.test(entry.name));
  return typeof field?.value === 'string' ? field.value : undefined;
}

export const greenhouse = atsConnector('greenhouse', async (entry, context) => {
  const body = await context.runtime.fetchJson<{ jobs?: GreenhouseJob[] }>(
    endpoint('greenhouse', entry.token),
  );
  return (body.jobs ?? [])
    .filter((job) => job.absolute_url)
    .map((job) =>
      row('greenhouse', entry, {
        title: job.title,
        location: job.location?.name,
        url: job.absolute_url!,
        postedAt: toEpochMs(job.first_published ?? job.updated_at),
        // Greenhouse double-escapes its HTML; normalizeDescription runs to a fixed point.
        description: job.content ?? '',
        structured: {
          // No employment type in this API — it stays undefined and the text decides.
          workMode: workModeFrom(greenhouseMetadata(job, /location\s*type|work\s*(?:mode|place|type)|remote/i)),
          // Both of these are whole location strings, not parts: offices[0].location is
          // "San Francisco, CA" and location.name is "San Francisco". Joining them produced
          // "San Francisco, CA, San Francisco" whenever the two spellings differed.
          location:
            text(job.offices?.[0]?.location) ??
            text(job.offices?.[0]?.name) ??
            text(job.location?.name),
          department: text(job.departments?.[0]?.name),
          sections: parseSections(job.content),
        },
      }),
    );
});

interface LeverJob {
  text?: string;
  hostedUrl?: string;
  createdAt?: number;
  descriptionPlain?: string;
  additionalPlain?: string;
  lists?: { text?: string; content?: string }[];
  categories?: {
    location?: string;
    allLocations?: string[];
    commitment?: string;
    department?: string;
    team?: string;
  };
  workplaceType?: string;
  country?: string;
}

/**
 * `lists[]` IS the sections array — heading in `text`, `<li>` bullets in `content`. Lever did
 * the structuring for us; re-deriving it from the flattened body would be pure loss.
 */
function leverSections(job: LeverJob): Section[] {
  return (job.lists ?? [])
    .map((list) => ({ heading: text(list.text) ?? '', items: parseSections(list.content)[0]?.items ?? [] }))
    .filter((section) => section.heading !== '' && section.items.length > 0);
}

export const lever = atsConnector('lever', async (entry, context) => {
  const jobs = await context.runtime.fetchJson<LeverJob[]>(endpoint('lever', entry.token));
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job.hostedUrl)
    .map((job) =>
      row('lever', entry, {
        title: job.text,
        location: job.categories?.location ?? job.categories?.allLocations?.join(', '),
        url: job.hostedUrl!,
        postedAt: toEpochMs(job.createdAt),
        // Lever splits the body across three fields plus a `lists[]` array of HTML bullets.
        // Reassembling them here is what makes its enrichment hash match Greenhouse's for
        // the same job (finding B).
        description: [
          job.descriptionPlain ?? '',
          ...(job.lists ?? []).map((list) => `${list.text ?? ''} ${list.content ?? ''}`),
          job.additionalPlain ?? '',
        ].join('\n'),
        structured: {
          employmentType: employmentTypeFrom(job.categories?.commitment),
          workMode: workModeFrom(job.workplaceType),
          location: locationFrom(job.categories?.location, job.country),
          department: text(job.categories?.department),
          team: text(job.categories?.team),
          sections: leverSections(job),
        },
      }),
    );
});

interface AshbyJob {
  title?: string;
  location?: string;
  publishedAt?: string;
  jobUrl?: string;
  descriptionPlain?: string;
  descriptionHtml?: string;
  isListed?: boolean;
  department?: string;
  team?: string;
  employmentType?: string;
  isRemote?: boolean;
  workplaceType?: string;
  address?: {
    postalAddress?: { addressLocality?: string; addressRegion?: string; addressCountry?: string };
  };
}

export const ashby = atsConnector('ashby', async (entry, context) => {
  const body = await context.runtime.fetchJson<{ jobs?: AshbyJob[] }>(
    endpoint('ashby', entry.token),
  );
  return (body.jobs ?? [])
    .filter((job) => job.jobUrl && job.isListed !== false)
    .map((job) =>
      row('ashby', entry, {
        title: job.title,
        location: job.location,
        url: job.jobUrl!,
        postedAt: toEpochMs(job.publishedAt),
        // Ashby's "plain" text is really markdown; normalizeDescription strips the markers.
        description: job.descriptionPlain ?? job.descriptionHtml ?? '',
        structured: {
          employmentType: employmentTypeFrom(job.employmentType),
          workMode: workModeFrom(job.workplaceType, job.isRemote),
          location: locationFrom(
            job.address?.postalAddress?.addressLocality ?? job.location,
            job.address?.postalAddress?.addressRegion,
            job.address?.postalAddress?.addressCountry,
          ),
          department: text(job.department),
          team: text(job.team),
          // The HTML keeps the list structure the markdown body also has; prefer the markup.
          sections: parseSections(job.descriptionHtml ?? job.descriptionPlain),
        },
      }),
    );
});

interface SmartRecruitersPosting {
  id?: string;
  name?: string;
  releasedDate?: string;
  location?: { fullLocation?: string };
}

interface SmartRecruitersDetail {
  postingUrl?: string;
  applyUrl?: string;
  jobAd?: { sections?: Record<string, { title?: string; text?: string }> };
  typeOfEmployment?: { label?: string };
  department?: { label?: string };
  location?: { remote?: boolean; city?: string; region?: string; country?: string };
}

/**
 * NEEDS A HUMAN SIGN-OFF, and is called out in the PR rather than left in a diff.
 *
 * `api.smartrecruiters.com/robots.txt` is `User-agent: * / Disallow: /`, with an explicit
 * `Allow: /v1/companies/` carved out for LinkedInBot. Taken literally that refuses us, and
 * the runtime does refuse it by default — this is the one ATS connector that has to opt out.
 *
 * The case for opting out: `/v1/companies/{id}/postings` is SmartRecruiters' documented,
 * unauthenticated Posting API, it is what a company's own careers page calls, we identify
 * ourselves with a contact address, and the registry has exactly one SmartRecruiters company
 * — one request per run. The case against is that `Disallow: /` is `Disallow: /`.
 *
 * The call went against opting out. `Disallow: /` is `Disallow: /`, and the `Allow:` line
 * for LinkedInBot shows SmartRecruiters decided deliberately who reaches this path rather
 * than leaving a careless blanket rule. This connector therefore reports a clean refusal
 * per target and the rest of the run is unaffected. Cost: one company out of 74.
 *
 * To reverse, restore `{ respectRobots: false }` here.
 */
const SMARTRECRUITERS_FETCH = {} as const;

export const smartrecruiters = atsConnector('smartrecruiters', async (entry, context) => {
  const body = await context.runtime.fetchJson<{ content?: SmartRecruitersPosting[] }>(
    endpoint('smartrecruiters', entry.token, { limit: '100' }),
    SMARTRECRUITERS_FETCH,
  );
  const postings: ConnectorPosting[] = [];

  // ponytail: the list endpoint carries no description, so the body costs one extra request
  // per posting. Fine at the registry's current SmartRecruiters volume (one company); if
  // that grows past a few dozen openings, cache detail bodies on `id` between runs.
  for (const posting of body.content ?? []) {
    if (!posting.id) continue;
    const detail = await context.runtime.fetchJson<SmartRecruitersDetail>(
      `${endpoint('smartrecruiters', entry.token)}/${posting.id}`,
      SMARTRECRUITERS_FETCH,
    );
    const url = detail.postingUrl ?? detail.applyUrl;
    if (!url) continue;
    postings.push(
      row('smartrecruiters', entry, {
        title: posting.name,
        location: posting.location?.fullLocation,
        url,
        postedAt: toEpochMs(posting.releasedDate),
        description: Object.values(detail.jobAd?.sections ?? {})
          .map((section) => `${section.title ?? ''}\n${section.text ?? ''}`)
          .join('\n'),
        structured: {
          employmentType: employmentTypeFrom(detail.typeOfEmployment?.label),
          workMode: workModeFrom(undefined, detail.location?.remote),
          // `fullLocation` is the already-joined whole, not a fourth part. Passing both gave
          // "San Francisco, California, United States, San Francisco, California, United
          // States", because locationFrom only dedupes on exact per-argument equality.
          location:
            locationFrom(detail.location?.city, detail.location?.region, detail.location?.country) ??
            text(posting.location?.fullLocation),
          department: text(detail.department?.label),
          // `jobAd.sections` is already {title, html} per section — no parsing of the whole
          // body, just of each section's own markup.
          sections: Object.values(detail.jobAd?.sections ?? {}).flatMap((section) => {
            const items = parseSections(section.text).flatMap((parsed) => parsed.items);
            const heading = text(section.title);
            return heading && items.length > 0 ? [{ heading, items }] : [];
          }),
        },
      }),
    );
  }
  return postings;
});

interface WorkableJob {
  title?: string;
  department?: string;
  employment_type?: string;
  url?: string;
  published_on?: string;
  created_at?: string;
  description?: string;
  city?: string;
  state?: string;
  country?: string;
  telecommuting?: boolean;
}

export const workable = atsConnector('workable', async (entry, context) => {
  const body = await context.runtime.fetchJson<{ jobs?: WorkableJob[] }>(
    endpoint('workable', entry.token, { details: 'true' }),
  );
  return (body.jobs ?? [])
    .filter((job) => job.url)
    .map((job) =>
      row('workable', entry, {
        title: job.title,
        location: job.telecommuting
          ? 'Remote'
          : [job.city, job.state, job.country].filter(Boolean).join(', '),
        url: job.url!,
        postedAt: toEpochMs(job.published_on ?? job.created_at),
        description: job.description ?? '',
        structured: {
          employmentType: employmentTypeFrom(job.employment_type),
          workMode: workModeFrom(undefined, job.telecommuting),
          location: locationFrom(job.city, job.state, job.country),
          department: text(job.department),
          sections: parseSections(job.description),
        },
      }),
    );
});

interface RecruiteeOffer {
  title?: string;
  department?: string;
  employment_type_code?: string;
  remote?: boolean;
  hybrid?: boolean;
  on_site?: boolean;
  careers_url?: string;
  careers_apply_url?: string;
  published_at?: string;
  created_at?: string;
  description?: string;
  requirements?: string;
  location?: string;
  city?: string;
  country?: string;
}

export const recruitee = atsConnector('recruitee', async (entry, context) => {
  const body = await context.runtime.fetchJson<{ offers?: RecruiteeOffer[] }>(
    endpoint('recruitee', entry.token),
  );
  return (body.offers ?? [])
    .filter((offer) => offer.careers_url ?? offer.careers_apply_url)
    .map((offer) =>
      row('recruitee', entry, {
        title: offer.title,
        location: offer.location ?? [offer.city, offer.country].filter(Boolean).join(', '),
        url: (offer.careers_url ?? offer.careers_apply_url)!,
        postedAt: toEpochMs(offer.published_at ?? offer.created_at),
        description: `${offer.description ?? ''}\n${offer.requirements ?? ''}`,
        structured: {
          employmentType: employmentTypeFrom(offer.employment_type_code),
          workMode: offer.hybrid ? 'hybrid' : offer.remote ? 'remote' : offer.on_site ? 'onsite' : undefined,
          location: locationFrom(offer.city, offer.location, offer.country),
          department: text(offer.department),
          sections: parseSections(`${offer.description ?? ''}\n${offer.requirements ?? ''}`),
        },
      }),
    );
});

export const atsConnectors: Connector[] = [
  greenhouse,
  lever,
  ashby,
  smartrecruiters,
  workable,
  recruitee,
];
