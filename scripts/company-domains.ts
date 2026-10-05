// Proposes each registry board's employer mail domain for a human to check; never writes on its own.
//   node --env-file-if-exists=.env.local scripts/company-domains.ts > domains.tsv   propose
//   node scripts/company-domains.ts --write domains.tsv                            apply the checked TSV
// Each proposal is a seed `website` or the most common host in that company's stored postings.
import { readFileSync, writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { postingContacts } from '../worker/outreach.ts';
import { openDb } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import { SEEDS } from './resolve-companies.ts';

const path = new URL('./companies.json', import.meta.url);
const companies: { name: string; ats: string; token: string; domain?: string }[] = JSON.parse(readFileSync(path, 'utf8'));
const write = process.argv.indexOf('--write');
if (write > 0) {
  const chosen = new Map(readFileSync(process.argv[write + 1], 'utf8').trim().split('\n').map((line) => {
    const [, board, domain] = line.split('\t'); return [board, domain?.trim().toLowerCase()];
  }));
  for (const item of companies) { const domain = chosen.get(`${item.ats}:${item.token}`); if (domain) item.domain = domain; }
  writeFileSync(path, `${JSON.stringify(companies, null, 2)}\n`);
} else {
  const db = openDb();
  const websites = new Map(SEEDS.filter((seed) => seed.website).map((seed) => [seed.name.toLowerCase(), seed.website!]));
  for (const item of companies.filter((c) => !c.domain)) {
    const website = websites.get(item.name.toLowerCase());
    if (website) { console.log([item.name, `${item.ats}:${item.token}`, website, 'seed'].join('\t')); continue; }
    const rows = db.select({ d: postings.description }).from(postings).where(eq(postings.company, item.name)).limit(50).all();
    const counts = new Map<string, number>();
    for (const { d } of rows) for (const host of postingContacts(d ?? '').domains) counts.set(host, (counts.get(host) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1]);
    console.log([item.name, `${item.ats}:${item.token}`, top?.[0] ?? '', top?.[1] ?? 0].join('\t'));
  }
}
