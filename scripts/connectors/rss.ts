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
export const jobspresso = rssConnector(
  'jobspresso',
  'https://jobspresso.co/?feed=job_feed',
  (item) => {
    const [company, place] = (item.creator ?? '').split(/<br\s*\/?>/i);
    return {
      company: (company ?? '').trim(),
      title: (item.title ?? '').trim(),
      location: (place ?? '').replace(/[⚲ ]/g, ' ').trim() || 'Remote',
    };
  },
  {
    // jobspresso.co robots.txt carries `Disallow: /*?`, which matches its own published feed
    // URL (`/?feed=job_feed`). That rule is aimed at crawler query-string explosion, not at
    // the syndication feed the site publishes for exactly this purpose. One request per run.
    respectRobots: false,
  },
);

export const rssConnectors: Connector[] = [weworkremotely, jobspresso];
