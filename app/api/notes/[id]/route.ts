import { z } from 'zod';
import { getDb, needsTurso } from '@/lib/db';
import { writeGate } from '@/lib/write-gate';
import { NotePatch, deleteNote, updateNote } from '@/lib/notes';

const Id = z.coerce.number().int().positive();
type Context = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: Context) {
  const denied = writeGate(request);
  if (denied) return denied;
  const id = Id.safeParse((await context.params).id);
  if (!id.success) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    const input = NotePatch.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: 'invalid note' }, { status: 400 });
    const note = await updateNote(getDb(), id.data, input.data);
    return note ? Response.json(note) : Response.json({ error: 'not found' }, { status: 404 });
  } catch (error) {
    console.error('PATCH /api/notes/[id]', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}

export async function DELETE(request: Request, context: Context) {
  const denied = writeGate(request);
  if (denied) return denied;
  const id = Id.safeParse((await context.params).id);
  if (!id.success) return Response.json({ error: 'not found' }, { status: 404 });
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    return (await deleteNote(getDb(), id.data))
      ? new Response(null, { status: 204 })
      : Response.json({ error: 'not found' }, { status: 404 });
  } catch (error) {
    console.error('DELETE /api/notes/[id]', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
