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

/** Jobspresso puts `"Company<br>⚲&nbsp;Location"` in `dc:creator` and the role in the title. */
export const jobspresso: Connector = {
  ...rssConnector('jobspresso', 'https://jobspresso.co/?feed=job_feed', (item) => {
    const [company, place] = (item.creator ?? '').split(/<br\s*\/?>/i);
    return {
      company: (company ?? '').trim(),
      title: (item.title ?? '').trim(),
      location: (place ?? '').replace(/[⚲ ]/g, ' ').trim() || 'Remote',
    };
  }),
  // jobspresso.co robots.txt carries `Disallow: /*?`, which matches its own published feed
  // URL (`/?feed=job_feed`). That rule is plainly aimed at crawler query-string explosion
  // rather than at the syndication feed the site publishes for exactly this purpose - but
  // the project constraint is to respect robots.txt, and reading intent into a Disallow is
  // negotiating with it rather than respecting it. So this feed is refused too.
  //
  // Declared as a SKIP rather than left to fail the robots check inside `fetch`, the way
  // `remotive` is. Under a 30-minute scheduler that difference stops being cosmetic: an
  // in-fetch refusal is an `error` run, so it retried every cycle — re-fetching this
  // host's robots.txt 48 times a day to be told no 48 times, and sitting in
  // `npm run status` as a red connector rather than as a decision someone made. A host
  // that has refused us gets asked once, when we decide whether to run it.
  //
  // Worth trying before reversing this: a path-based feed URL (e.g. /feed/) that robots.txt
  // permits outright would make the question moot. To reverse, delete this `skip` and pass
  // `respectRobots: false` to `rssConnector`.
  skip: () => 'jobspresso.co/robots.txt disallows /*? (its own feed URL) — left in place, not run',
};

export const rssConnectors: Connector[] = [weworkremotely, weworkremotelyDesign, dribbble, jobspresso];
