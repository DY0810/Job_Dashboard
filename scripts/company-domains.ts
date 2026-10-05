// Proposes each registry board's employer mail domain for a human to check; never writes on its own.
//   node --env-file-if-exists=.env.local scripts/company-domains.ts > domains.tsv   propose
//   node scripts/company-domains.ts --write domains.tsv                            apply the checked TSV
// Each proposal is a seed `website` or the most common host in that company's stored postings.
import { readFileSync, writeFileSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { postingContacts } from '../worker/outreach.ts';
import { openDb } from '../lib/db/index.ts';
import { postings } from '../lib/db/schema.ts';
import { DomainSchema } from '../lib/applications/worker-protocol.ts';
import { SEEDS } from './resolve-companies.ts';

const path = new URL('./companies.json', import.meta.url);
const companies: { name: string; ats: string; token: string; domain?: string }[] = JSON.parse(readFileSync(path, 'utf8'));
// Only ATSes application-identity.ts resolves ever reach outreach; a domain on any other board is dead.
const IDENTIFIED = new Set(['greenhouse', 'ashby', 'lever', 'jobvite', 'workday', 'oracle', 'icims']);
const write = process.argv.indexOf('--write');
if (write > 0) {
  const file = process.argv[write + 1];
  if (!file) throw new Error('--write needs the edited TSV path.');
  const rows = readFileSync(file, 'utf8').trim().split('\n').map((line) => line.split('\t'))
    .filter(([, board, domain]) => board?.includes(':') && domain?.trim()) // skips a header and rows left blank
    .map(([name, board, domain]) => ({ name, board, domain: domain.trim().toLowerCase() }));
  const bad = rows.filter((row) => !DomainSchema.safeParse(row.domain).success);
  if (bad.length) throw new Error(`Not a domain: ${bad.map((row) => `${row.board} "${row.domain}"`).join(', ')}`);
  const boards = new Map(companies.map((item) => [`${item.ats}:${item.token}`, item]));
  const unmatched = rows.filter((row) => !boards.has(row.board)).map((row) => row.board);
  for (const row of rows) { const item = boards.get(row.board); if (item) item.domain = row.domain; }
  writeFileSync(path, `${JSON.stringify(companies, null, 2)}\n`);
  console.log(`applied ${rows.length - unmatched.length}, unmatched: ${JSON.stringify(unmatched)}`);
} else {
  const db = openDb();
  const websites = new Map(SEEDS.filter((seed) => seed.website).map((seed) => [seed.name.toLowerCase(), seed.website!]));
  for (const item of companies.filter((c) => !c.domain && IDENTIFIED.has(c.ats))) {
    const website = websites.get(item.name.toLowerCase());
    if (website) { console.log([item.name, `${item.ats}:${item.token}`, website, 'seed'].join('\t')); continue; }
    const rows = db.select({ d: postings.description }).from(postings).where(eq(postings.company, item.name)).limit(50).all();
    const counts = new Map<string, number>();
    for (const { d } of rows) for (const host of postingContacts(d ?? '').domains) counts.set(host, (counts.get(host) ?? 0) + 1);
    const [top] = [...counts].sort((a, b) => b[1] - a[1]);
    console.log([item.name, `${item.ats}:${item.token}`, top?.[0] ?? '', top?.[1] ?? 0].join('\t'));
  }
}
