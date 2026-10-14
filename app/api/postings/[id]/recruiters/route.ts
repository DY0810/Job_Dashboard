import { z } from 'zod';
import { lookupApplicant, privateJson } from '@/lib/applicant-access';
import { getDb, needsTurso } from '@/lib/db';
import { getPostingDetail } from '@/lib/query';
import { findRecruiters } from '@/lib/recruiters';

export const dynamic = 'force-dynamic';

const Id = z.coerce.number().int().positive();

/** The people to reach at a posting's employer. Signed-in only: the board is public and every lookup spends Hunter quota. */
export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = await lookupApplicant(request);
  if (auth instanceof Response) return auth;

  const id = Id.safeParse((await context.params).id);
  if (!id.success) return privateJson({ error: 'not found' }, { status: 404 });
  try {
    if (needsTurso()) return privateJson({ error: 'database not configured' }, { status: 503 });
    const posting = await getPostingDetail(getDb(), id.data);
    if (!posting) return privateJson({ error: 'not found' }, { status: 404 });
    return privateJson(await findRecruiters(posting, { key: process.env.WORKIE_HUNTER_API_KEY }));
  } catch (error) {
    console.error('GET /api/postings/[id]/recruiters', error);
    return privateJson({ error: 'internal error' }, { status: 500 });
  }
}
