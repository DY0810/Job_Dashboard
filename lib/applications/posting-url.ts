/** The public job-post URL for an application identity, or null for an ATS without a known board. */
export function postingUrl(ats: string, tenant: string, requisition: string): string | null {
  if (ats === 'greenhouse') return `https://job-boards.greenhouse.io/${tenant}/jobs/${requisition}`;
  if (ats === 'ashby') return `https://jobs.ashbyhq.com/${tenant}/${requisition}`;
  if (ats === 'lever') return tenant.startsWith('jobs.eu.lever.co:')
    ? `https://jobs.eu.lever.co/${tenant.slice(17)}/${requisition}` : `https://jobs.lever.co/${tenant}/${requisition}`;
  return null;
}
