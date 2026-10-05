import companies from '../../scripts/companies.json' with { type: 'json' };

const byBoard = new Map((companies as { ats: string; token: string; domain?: string }[])
  .filter((item) => item.domain).map((item) => [`${item.ats}:${item.token}`, item.domain!.toLowerCase()]));

/** The employer's mail domain, checked by a human once per board. Null when not curated. */
export const registryDomain = (ats: string, tenant: string) => byBoard.get(`${ats}:${tenant}`) ?? null;
