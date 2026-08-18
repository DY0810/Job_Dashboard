/**
 * RSS feeds (plan Phase 6), parsed with the already-installed `rss-parser`.
 * `source_priority = 3` — below the ATS and the JSON aggregators.
 *
 * The feed body goes through `context.runtime.fetchText` and then `parseString`, never
 * `parser.parseURL`: parseURL does its own fetch, which would sidestep the timeout, the rate
 * limiter, the robots check and the fixture replay all at once.
 */

import Parser from 'rss-parser';

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
}

type FeedMapper = (item: FeedItem) => { company: string; title: string; location: string | null };

function rssConnector(
  name: string,
  url: string,
  map: FeedMapper,
  fetchOptions: FetchOptions = {},
): Connector {
  const parser = new Parser<unknown, FeedItem>({ customFields: { item: ['region'] } });
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
          };
        });
    },
  };
}

/** WWR encodes the pair as `"Company: Role"` and puts the location in a `<region>` element. */
export const weworkremotely = rssConnector(
  'weworkremotely',
  'https://weworkremotely.com/remote-jobs.rss',
  (item) => {
    const raw = item.title ?? '';
    const split = raw.indexOf(':');
    return {
      company: split > 0 ? raw.slice(0, split).trim() : '',
      title: (split > 0 ? raw.slice(split + 1) : raw).trim(),
      location: item.region?.trim() || 'Remote',
    };
  },
);

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

export const rssConnectors: Connector[] = [weworkremotely, jobspresso];
