import { z } from 'zod';
import { getDb, needsTurso } from '@/lib/db';
import { getPostingDetail } from '@/lib/query';

const Id = z.coerce.number().int().positive();

/**
 * The only route handler in the app. Everything the table renders is already in the row; this
 * exists solely so full description bodies are fetched one at a time instead of shipped for
 * every posting on first paint.
 */
export const preferredRegion = 'pdx1';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const id = Id.safeParse((await context.params).id);
  if (!id.success) return Response.json({ error: 'not found' }, { status: 404 });

  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });

    const posting = await getPostingDetail(getDb(), id.data);
    if (!posting) return Response.json({ error: 'not found' }, { status: 404 });
    return Response.json(posting);
  } catch (error) {
    // The message can carry table and column names; the client gets none of it.
    console.error('GET /api/postings/[id]', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
