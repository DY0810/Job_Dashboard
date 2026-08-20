/** Every enabled connector, in the order `scripts/ingest.ts` starts them. */

import type { Connector } from '../../lib/runtime.ts';

import { amazon } from './amazon.ts';
import { atsConnectors } from './ats.ts';
import { aggConnectors } from './agg.ts';
import { keyedConnectors } from './keyed.ts';
import { rssConnectors } from './rss.ts';
import { repoConnectors } from './repo.ts';

export const connectors: Connector[] = [
  ...atsConnectors,
  amazon,
  ...aggConnectors,
  ...keyedConnectors,
  ...rssConnectors,
  ...repoConnectors,
];

export { amazon, atsConnectors, aggConnectors, keyedConnectors, rssConnectors, repoConnectors };
