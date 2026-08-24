import { z } from 'zod';
import { getDb, needsTurso } from '@/lib/db';
import { writeGate } from '@/lib/write-gate';
import { CommentInput, addComment } from '@/lib/notes';

const Id = z.coerce.number().int().positive();

/** Reply to a note. Same public-write posture as the note itself: validated and capped. */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const denied = writeGate(request);
  if (denied) return denied;
  const id = Id.safeParse((await context.params).id);
  if (!id.success) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    const input = CommentInput.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: 'invalid comment' }, { status: 400 });
    const comment = await addComment(getDb(), id.data, input.data);
    return comment
      ? Response.json(comment, { status: 201 })
      : Response.json({ error: 'not found' }, { status: 404 });
  } catch (error) {
    console.error('POST /api/notes/[id]/comments', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
