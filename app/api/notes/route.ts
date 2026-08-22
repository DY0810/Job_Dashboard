import { z } from 'zod';
import { getDb, needsTurso } from '@/lib/db';
import { MAX_NOTES_PER_WEEK, NoteInput, countActivitySince, createNote, listNotes, weekKey } from '@/lib/notes';

const Since = z.coerce.number().int().min(0).catch(0);

/** `?since=<ms>` → how many notes and replies a viewer has not seen. Never cached. */
export async function GET(request: Request) {
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    const since = Since.parse(new URL(request.url).searchParams.get('since'));
    return Response.json({ count: await countActivitySince(getDb(), since) });
  } catch (error) {
    console.error('GET /api/notes', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}

/** Anyone with the URL can post — hence the size cap per note and the count cap per week. */
export async function POST(request: Request) {
  try {
    if (needsTurso()) return Response.json({ error: 'database not configured' }, { status: 503 });
    const input = NoteInput.safeParse(await request.json().catch(() => null));
    if (!input.success) return Response.json({ error: 'invalid note' }, { status: 400 });

    const db = getDb();
    if ((await listNotes(db, weekKey(new Date()))).length >= MAX_NOTES_PER_WEEK) {
      return Response.json({ error: 'this week is full' }, { status: 429 });
    }
    return Response.json(await createNote(db, input.data), { status: 201 });
  } catch (error) {
    console.error('POST /api/notes', error);
    return Response.json({ error: 'internal error' }, { status: 500 });
  }
}
