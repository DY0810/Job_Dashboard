import { z } from 'zod';
import { getDb, needsTurso } from '@/lib/db';
import { writeGate } from '@/lib/write-gate';
import { deleteComment } from '@/lib/notes';

const Id = z.coerce.number().int().positive();

/**
 * Both ids are parsed and both are used. The note segment scopes the delete — see
 * `deleteComment` — so this route cannot reach a comment that lives under a different note.
 */
export async function DELETE(request: Request, context: { params: Promise<{ id: string; cid: string }> }) {
  const denied = writeGate(request);
  if (denied) return denied;
  const params = await context.params;
  const id = Id.safeParse(params.id);
  const cid = Id.safeParse(params.cid);
  if (!id.success || !cid.success) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    return (await deleteComment(getDb(), id.data, cid.data))
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'not found' }, { status: 404 });
  } catch (error) {
    console.error('DELETE /api/notes/[id]/comments/[cid]', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
