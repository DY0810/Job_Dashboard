import { ApplicationIdentitySchema } from './worker-protocol.ts';

export type OfficialIdentity = { ats: string; tenant: string; requisition: string };
export type IdentitySource = { source: string; sourceUrl: string; publisherId: string | null };
export type IdentityResolution = {
  status: 'resolved' | 'unresolved' | 'conflict';
  identity: OfficialIdentity | null;
  officialUrl: string | null;
  aliases: string[];
  reasons: string[];
};

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const tenantPart = '[A-Za-z0-9_-]+';
const key = (identity: OfficialIdentity) => JSON.stringify([identity.ats, identity.tenant, identity.requisition]);

/** Only known vendor-hosted shapes. A URL is an identity hint, never submission authority. */
function official(value: string): { identity: OfficialIdentity; url: string } | null {
  if (!value.startsWith('https://') || /[\s\\]/.test(value)) return null;
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (url.username || url.password || url.port || url.pathname.includes('%')) return null;
  const host = url.hostname, path = url.pathname.replace(/\/$/, '');
  let match: RegExpMatchArray | null, ats: string, tenant: string, requisition: string, canonical = path;
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(host)) {
    ats = 'greenhouse';
    match = path.match(new RegExp(`^/(${tenantPart})/jobs/([0-9]+)$`));
    if (match) [, tenant, requisition] = match;
    else if (path === '/embed/job_app') {
      const tenants = url.searchParams.getAll('for'), ids = url.searchParams.getAll('token');
      if (tenants.length !== 1 || ids.length !== 1 || !new RegExp(`^${tenantPart}$`).test(tenants[0]) ||
          !/^[0-9]+$/.test(ids[0])) return null;
      [tenant, requisition] = [tenants[0], ids[0]];
    } else return null;
    url.hostname = 'job-boards.greenhouse.io';
    canonical = `/${tenant}/jobs/${requisition}`;
  } else if (host === 'jobs.ashbyhq.com' || host === 'jobs.lever.co' || host === 'jobs.eu.lever.co') {
    ats = host === 'jobs.ashbyhq.com' ? 'ashby' : 'lever';
    match = path.match(new RegExp(`^/(${tenantPart})/(${UUID})(?:/${ats === 'ashby' ? 'application' : 'apply'})?$`));
    if (!match) return null;
    tenant = host === 'jobs.eu.lever.co' ? `${host}:${match[1]}` : match[1];
    requisition = match[2].toLowerCase();
    canonical = `/${match[1]}/${requisition}`;
  } else if (host === 'jobs.jobvite.com') {
    match = path.match(new RegExp(`^/(${tenantPart})/job/([A-Za-z0-9]+)(?:/apply)?$`));
    if (!match) return null;
    [, tenant, requisition] = match;
    ats = 'jobvite';
    canonical = `/${tenant}/job/${requisition}`;
  } else if (/^[a-z0-9-]+\.wd[0-9]+\.myworkdayjobs\.com$/.test(host)) {
    match = path.match(/^\/(?:[a-z]{2}-[A-Z]{2}\/)?[A-Za-z0-9_-]+\/job\/(?:[^/]+\/)?[^/]+_([A-Za-z0-9-]*[0-9][A-Za-z0-9-]*)(?:\/apply)?$/);
    if (!match) return null;
    [ats, tenant, requisition] = ['workday', host, match[1]];
    canonical = path.replace(/^\/[a-z]{2}-[A-Z]{2}\//, '/').replace(/\/apply$/, '');
  } else if (/^[a-z0-9-]+\.fa\.[a-z0-9-]+\.oraclecloud\.com$/.test(host)) {
    match = path.match(/^\/hcmUI\/CandidateExperience\/[a-z]{2}(?:-[A-Z]{2})?\/sites\/[A-Za-z0-9_-]+\/job\/([0-9]+)(?:\/apply)?$/);
    if (!match) return null;
    [ats, tenant, requisition] = ['oracle', host, match[1]];
    canonical = path.replace(/\/apply$/, '');
  } else if (/^[a-z0-9-]+\.icims\.com$/.test(host)) {
    match = path.match(/^\/jobs\/([0-9]+)\/(?:[^/]+\/)?job$/);
    if (!match) return null;
    [ats, tenant, requisition] = ['icims', host, match[1]];
    canonical = `/jobs/${requisition}/job`;
  } else return null;
  const identity = ApplicationIdentitySchema.safeParse({ ats, tenant, requisition });
  return identity.success ? { identity: identity.data, url: `https://${url.hostname}${canonical}` } : null;
}

export function resolveApplicationIdentity(canonicalUrl: string, sources: IdentitySource[]): IdentityResolution {
  const aliases = [...new Set([canonicalUrl, ...sources.map((source) => source.sourceUrl)])].sort();
  const matches = aliases.flatMap((url) => { const found = official(url); return found ? [found] : []; });
  const reasons = new Set<string>();
  const identities = new Map(matches.map((match) => [key(match.identity), match.identity]));
  if (identities.size > 1) reasons.add('conflicting_official_identities');
  for (const value of aliases) {
    let url: URL;
    try { url = new URL(value); } catch { continue; }
    if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname) &&
        url.pathname.replace(/\/$/, '') === '/embed/job_app' &&
        (new Set(url.searchParams.getAll('token')).size > 1 || new Set(url.searchParams.getAll('for')).size > 1)) {
      reasons.add('conflicting_identity_parameters');
    }
  }
  for (const source of sources) {
    const found = official(source.sourceUrl);
    if (!found || source.source !== found.identity.ats || !source.publisherId) continue;
    // Older collectors persisted the whole URL; it is not a native requisition.
    const fallback = official(source.publisherId);
    if (fallback ? key(fallback.identity) !== key(found.identity) : source.publisherId !== found.identity.requisition) {
      reasons.add('conflicting_publisher_identity');
    }
  }
  const status = reasons.size ? 'conflict' : identities.size === 1 ? 'resolved' : 'unresolved';
  if (status === 'unresolved') reasons.add('official_identity_unresolved');
  return {
    status, identity: status === 'resolved' ? identities.values().next().value! : null,
    officialUrl: status === 'resolved' ? matches.map((match) => match.url).sort()[0] : null,
    aliases, reasons: [...reasons].sort(),
  };
}
