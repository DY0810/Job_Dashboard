import { z } from 'zod';
import { getDb, needsTurso } from '@/lib/db';
import { deleteComment } from '@/lib/notes';

const Id = z.coerce.number().int().positive();

export async function DELETE(_request: Request, context: { params: Promise<{ id: string; cid: string }> }) {
  const cid = Id.safeParse((await context.params).cid);
  if (!cid.success) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    return (await deleteComment(getDb(), cid.data))
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'not found' }, { status: 404 });
  } catch (error) {
    console.error('DELETE /api/notes/[id]/comments/[cid]', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
