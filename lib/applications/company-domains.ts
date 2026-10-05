import companies from '../../scripts/companies.json' with { type: 'json' };

type Board = { ats: string; token: string; wdN?: string; domain?: string };

/** The (ats, tenant) that application-identity.ts derives for this board: Workday's tenant is its host. */
export const boardKey = (board: Board) =>
  `${board.ats}:${board.ats === 'workday' ? `${board.token}.${board.wdN}.myworkdayjobs.com` : board.token}`;

// ponytail: the registry records no Lever region, so a jobs.eu.lever.co tenant never matches; add `region` when one exists.
const byBoard = new Map((companies as Board[]).filter((item) => item.domain).map((item) => [boardKey(item), item.domain!.toLowerCase()]));

/** The employer's mail domain, checked by a human once per board. Null when not curated. */
export const registryDomain = (ats: string, tenant: string) => byBoard.get(`${ats}:${tenant}`) ?? null;
