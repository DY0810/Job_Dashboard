/**
 * RSS feeds (plan Phase 6), parsed with the already-installed `rss-parser`.
 * `source_priority = 3` — below the ATS and the JSON aggregators.
 *
 * The feed body goes through `context.runtime.fetchText` and then `parseString`, never
 * `parser.parseURL`: parseURL does its own fetch, which would sidestep the timeout, the rate
 * limiter, the robots check and the fixture replay all at once.
 */

import Parser from 'rss-parser';

import type { EmploymentType } from '../../lib/extract.ts';
import { normalizeDescription } from '../../lib/normalize.ts';
import {
  toEpochMs,
  type Connector,
  type ConnectorContext,
  type ConnectorPosting,
  type FetchOptions,
} from '../../lib/runtime.ts';

interface FeedItem {
  title?: string;
  link?: string;
  pubDate?: string;
  isoDate?: string;
  content?: string;
  contentSnippet?: string;
  creator?: string;
  region?: string;
  type?: string;
  category?: string;
}

/**
 * `employmentType` is optional and only set when the feed states it outright. A source that
 * says `<type>Contract</type>` is a better authority on the engagement than the prose
 * heuristics in `extract.ts`, and `sourceFields` is read before the body — which is the whole
 * reason the Design freelance split has anything to sort WeWorkRemotely rows by.
 */
type FeedMapper = (item: FeedItem) => {
  company: string;
  title: string;
  location: string | null;
  employmentType?: EmploymentType;
};

function rssConnector(
  name: string,
  url: string,
  map: FeedMapper,
  fetchOptions: FetchOptions = {},
): Connector {
  const parser = new Parser<unknown, FeedItem>({ customFields: { item: ['region', 'type', 'category'] } });
  return {
    name,
    kind: 'rss',
    // Every RSS source here publishes hourly at best, and a feed is the whole board in one
    // response — re-fetching it twice an hour cannot surface anything a single fetch missed.
    minIntervalMs: 60 * 60 * 1000,
    async fetch(context: ConnectorContext): Promise<ConnectorPosting[]> {
      const feed = await parser.parseString(await context.runtime.fetchText(url, fetchOptions));
      return (feed.items ?? [])
        .filter((item) => item.link)
        .map((item) => {
          const mapped = map(item);
          return {
            source: name,
            sourceKind: 'rss' as const,
            sourceUrl: item.link!,
            postedAt: toEpochMs(item.isoDate ?? item.pubDate),
            company: mapped.company,
            title: mapped.title,
            location: mapped.location,
            description: normalizeDescription(item.content ?? item.contentSnippet ?? ''),
            ...(mapped.employmentType ? { sourceFields: { employmentType: mapped.employmentType } } : {}),
          };
        });
    },
  };
}

/**
 * WWR's `<type>` element, which it publishes on every item. The live design feed carries only
 * `Full-Time` and `Contract` today, but WWR's own board offers the other three, so all five
 * are mapped rather than the two currently observed — an unmapped value is left undefined and
 * falls back to the prose heuristics, never guessed at.
 */
const WWR_TYPE: Record<string, EmploymentType> = {
  'full-time': 'full-time',
  'part-time': 'part-time',
  contract: 'contract',
  freelance: 'freelance',
  internship: 'internship',
};

/** WWR encodes the pair as `"Company: Role"` and puts the location in a `<region>` element. */
const wwrItem: FeedMapper = (item) => {
  const raw = item.title ?? '';
  const split = raw.indexOf(':');
  return {
    company: split > 0 ? raw.slice(0, split).trim() : '',
    title: (split > 0 ? raw.slice(split + 1) : raw).trim(),
    location: item.region?.trim() || 'Remote',
    employmentType: WWR_TYPE[(item.type ?? '').trim().toLowerCase()],
  };
};

export const weworkremotely = rssConnector(
  'weworkremotely',
  'https://weworkremotely.com/remote-jobs.rss',
  wwrItem,
);

/**
 * The same board, filtered to design by WWR itself. Worth a second connector rather than
 * relying on the feed above: that one is the 100 most recent postings across every category,
 * of which design is a small slice, while this is 82 design postings and reaches months
 * further back. Where they overlap, dedupe merges them into one posting with two sources.
 *
 * This is also the only source that supplies contract design work in any volume — WWR marks
 * it in `<type>`, which `wwrItem` passes through to the Design tab's freelance side.
 */
export const weworkremotelyDesign = rssConnector(
  'weworkremotely-design',
  'https://weworkremotely.com/categories/remote-design-jobs.rss',
  wwrItem,
);

/**
 * Dribbble's job board — the highest-signal design-only source available, and the reason it is
 * worth a bespoke parser: the feed carries no description and no structured fields at all, only
 * a sentence.
 *
 *   "Aurify LLC is hiring for a position of AI Creative Director in South Korea"
 *   "KAP STRATEGIES is hiring for a position of Graphic Designer anywhere"
 *
 * 53 of the 55 items parse; the two that do not are the channel's own title and the `anywhere`
 * form, both handled below. An item that still does not match keeps the whole sentence as its
 * title rather than being dropped — a posting with an ugly title is recoverable, a silently
 * skipped one is not.
 */
const DRIBBBLE = /^(.+?) is hiring for a position of (.+?)(?: in (.+)| anywhere)$/;

export const dribbble = rssConnector('dribbble', 'https://dribbble.com/jobs.rss', (item) => {
  const raw = (item.title ?? '').trim();
  const parsed = DRIBBBLE.exec(raw);
  return {
    // `dc:creator` is the employer and is present even on the items the sentence parse misses.
    company: (item.creator ?? parsed?.[1] ?? '').trim(),
    title: (parsed?.[2] ?? raw).trim(),
    // Group 3 is undefined for the `anywhere` form, which is Dribbble's way of saying remote.
    location: parsed ? (parsed[3]?.trim() ?? 'Remote') : null,
  };
});

/**
 * Jobspresso puts `"Company<br>⚲&nbsp;Location"` in `dc:creator` and the role in the title.
 *
 * The PATH feed, not `?feed=job_feed`. Jobspresso's robots.txt carries `Disallow: /*?`, so the
 * query form is refused for every posting — this connector logged
 * `robots.txt disallows https://jobspresso.co/` on every cycle and returned nothing at all.
 * `/jobs/feed/` is the same WP Job Manager feed reached without a query string: allowed, and
 * it serves 20 items where the query form served zero.
 */
export const jobspresso = rssConnector('jobspresso', 'https://jobspresso.co/jobs/feed/', (item) => {
  const [company, place] = (item.creator ?? '').split(/<br\s*\/?>/i);
  return {
    company: (company ?? '').trim(),
    title: (item.title ?? '').trim(),
    location: (place ?? '').replace(/[⚲ ]/g, ' ').trim() || 'Remote',
  };
});

/**
 * DesignJobs.careers — a design-only board, and the only genuinely new one with a keyless feed.
 *
 * Fixed 50-item firehose: `?limit=`, `?page=`, `?category=` and `?level=` are all ACCEPTED and
 * all IGNORED — page 2 returns a byte-identical body to page 1 — so there is exactly one URL
 * worth asking for. robots.txt is `Allow: /` with `Crawl-delay: 5` and does not mention /rss.
 *
 * Nothing is structured except `<category>`. Location and level are bolded labels inside the
 * CDATA description:
 *
 *   <p><strong>Location:</strong> Seattle, United States of America</p>
 *   <p><strong>Level:</strong> Entry Level</p>
 *
 * Per-label regexes rather than one positional match, because presence is NOT uniform — Level
 * appears on 43 of 50 items, Salary on 18, and there are six different label orders. A single
 * ordered pattern missed 32 of 50.
 *
 * Worth having despite a thin US slice (~10 of 50, and the sampled entry-level rows were all
 * outside the US): every item is design, the window is only ~7 hours wide, and a connector
 * polling hourly accumulates what one fetch cannot show.
 */
const DJ_LABEL = (label: string) =>
  new RegExp(`<strong>\\s*${label}\\s*:\\s*</strong>\\s*([^<]+)`, 'i');
const DJ_LOCATION = DJ_LABEL('Location');
const DJ_TYPE = DJ_LABEL('Type');

const DJ_TYPE_MAP: Record<string, EmploymentType> = {
  'full-time': 'full-time',
  'part-time': 'part-time',
  contract: 'contract',
  freelance: 'freelance',
  internship: 'internship',
};

export const designjobsCareers = rssConnector(
  'designjobs-careers',
  'https://designjobs.careers/rss',
  (item) => {
    const body = item.content ?? item.contentSnippet ?? '';
    return {
      // `dc:creator` is the employer; the title is the role alone, already separated.
      company: (item.creator ?? '').trim(),
      title: (item.title ?? '').trim(),
      location: DJ_LOCATION.exec(body)?.[1]?.trim() || null,
      employmentType: DJ_TYPE_MAP[(DJ_TYPE.exec(body)?.[1] ?? '').trim().toLowerCase()],
    };
  },
);

export const rssConnectors: Connector[] = [
  weworkremotely,
  weworkremotelyDesign,
  dribbble,
  jobspresso,
  designjobsCareers,
];
