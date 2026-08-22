/**
 * Talkie — shared post-it notes, bucketed by ISO week.
 *
 * One module, one seam: the routes and the page cross this interface and nothing else touches
 * the `notes` table. Every function takes `ReadDb` and awaits, so the same code runs against
 * the synchronous local driver and the asynchronous hosted one — the pattern `lib/query.ts`
 * established: type every query against the async driver, and `await` is a no-op on the sync one.
 *
 * Weeks are ISO 8601 (Monday to Sunday) in UTC. The Vercel function runs in UTC and the
 * laptop does not; computing in UTC is what makes "this week" mean the same thing on both.
 */

import { and, count, eq, gt, gte, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

import { driver, type ReadDb } from './db/index.ts';
import { noteComments, notes } from './db/schema.ts';

export type Note = typeof notes.$inferSelect;
export type Comment = typeof noteComments.$inferSelect;
/** What the board renders: a note with its thread, oldest reply first. */
export type NoteWithComments = Note & { comments: Comment[] };

const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

/** A public write endpoint on a site with no accounts needs a ceiling. 400 is the ceiling. */
export const MAX_NOTES_PER_WEEK = 400;

/** Board geometry in pixels. The bounds are the board's, and a note too small to read is a bug. */
export const NoteInput = z.object({
  body: z.string().trim().min(1).max(1000),
  author: z.string().trim().max(40).optional(),
  x: z.number().int().min(0).max(4000),
  y: z.number().int().min(0).max(4000),
  w: z.number().int().min(120).max(800),
  h: z.number().int().min(80).max(600),
});
export type NoteInput = z.infer<typeof NoteInput>;

/** What may change after a note exists: its text, or its width (height follows the text). */
export const NotePatch = NoteInput.pick({ body: true, w: true, h: true })
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: 'empty patch' });
export type NotePatch = z.infer<typeof NotePatch>;

export const CommentInput = z.object({
  body: z.string().trim().min(1).max(500),
  author: z.string().trim().max(40).optional(),
});
export type CommentInput = z.infer<typeof CommentInput>;

// ---------------------------------------------------------------------------------------
// ISO weeks
// ---------------------------------------------------------------------------------------

/** `2026-W34`. The Thursday of a week decides which year the week belongs to. */
export function weekKey(date: Date): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7; // Mon=1 … Sun=7
  d.setUTCDate(d.getUTCDate() + 4 - day); // the Thursday of this ISO week
  const isoYear = d.getUTCFullYear();
  const week = Math.ceil(((d.getTime() - Date.UTC(isoYear, 0, 1)) / DAY_MS + 1) / 7);
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

/** Half-open [Monday 00:00Z, next Monday 00:00Z). Null for a key no calendar contains. */
export function weekRange(key: string): { start: number; end: number } | null {
  const match = /^(\d{4})-W(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const week = Number(match[2]);
  if (week < 1 || week > 53) return null;
  // January 4th is always inside ISO week 1.
  const jan4Day = new Date(Date.UTC(year, 0, 4)).getUTCDay() || 7;
  const week1Monday = Date.UTC(year, 0, 4 - (jan4Day - 1));
  const start = week1Monday + (week - 1) * WEEK_MS;
  // A 52-week year has no W53; the round trip is the test.
  if (weekKey(new Date(start)) !== key) return null;
  return { start, end: start + WEEK_MS };
}

/** `Aug 17 – 23`, or `Dec 28 – Jan 3` across a month — what a calendar would print. */
export function weekLabel(key: string): string {
  const range = weekRange(key);
  if (!range) return key;
  const fmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const first = new Date(range.start);
  const last = new Date(range.end - 1);
  const sameMonth = first.getUTCMonth() === last.getUTCMonth();
  return `${fmt.format(first)} – ${sameMonth ? last.getUTCDate() : fmt.format(last)}`;
}

// ---------------------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------------------

export async function listNotes(db: ReadDb, week: string): Promise<NoteWithComments[]> {
  const range = weekRange(week);
  if (!range) return [];
  const rows = await driver(db)
    .select()
    .from(notes)
    .where(and(gte(notes.createdAt, new Date(range.start)), lt(notes.createdAt, new Date(range.end))))
    .orderBy(notes.createdAt)
    .all();
  if (rows.length === 0) return [];
  // One query for every thread on the board, then grouped: two round trips per page, not 1+N.
  const threads = await driver(db)
    .select()
    .from(noteComments)
    .where(inArray(noteComments.noteId, rows.map((row) => row.id)))
    .orderBy(noteComments.createdAt)
    .all();
  const byNote = new Map<number, Comment[]>();
  for (const comment of threads) byNote.set(comment.noteId, [...(byNote.get(comment.noteId) ?? []), comment]);
  return rows.map((row) => ({ ...row, comments: byNote.get(row.id) ?? [] }));
}

/** Every week that has a note, newest first — the calendar's contents. */
export async function listWeeks(db: ReadDb): Promise<string[]> {
  // ponytail: one timestamp per note, keyed in JS. Fine for a board of hundreds; switch to a
  // SQL week expression if the table ever reaches tens of thousands.
  const rows = await driver(db).select({ at: notes.createdAt }).from(notes).orderBy(notes.createdAt).all();
  const keys = new Set<string>();
  for (const row of rows) keys.add(weekKey(row.at));
  return [...keys].reverse();
}

export async function createNote(db: ReadDb, input: NoteInput, now: number = Date.now()): Promise<Note> {
  const at = new Date(now);
  const rows = await driver(db)
    .insert(notes)
    .values({ ...input, author: input.author || null, createdAt: at, updatedAt: at })
    .returning()
    .all();
  return rows[0]!;
}

export async function updateNote(
  db: ReadDb,
  id: number,
  patch: NotePatch,
  now: number = Date.now(),
): Promise<Note | null> {
  const rows = await driver(db)
    .update(notes)
    .set({ ...patch, updatedAt: new Date(now) })
    .where(eq(notes.id, id))
    .returning()
    .all();
  return rows[0] ?? null;
}

export async function deleteNote(db: ReadDb, id: number): Promise<boolean> {
  // Explicit, not ON DELETE CASCADE: SQLite only enforces foreign keys when the connection
  // turns the pragma on, and neither driver here promises that. Orphans would still count
  // as unread activity, so the thread goes first.
  await driver(db).delete(noteComments).where(eq(noteComments.noteId, id)).run();
  const rows = await driver(db).delete(notes).where(eq(notes.id, id)).returning({ id: notes.id }).all();
  return rows.length > 0;
}

/** The unread bubble: notes AND replies created strictly after the viewer's cursor. */
export async function countActivitySince(db: ReadDb, sinceMs: number): Promise<number> {
  const since = new Date(sinceMs);
  const [n, c] = await Promise.all([
    driver(db).select({ n: count() }).from(notes).where(gt(notes.createdAt, since)).all(),
    driver(db).select({ n: count() }).from(noteComments).where(gt(noteComments.createdAt, since)).all(),
  ]);
  return (n[0]?.n ?? 0) + (c[0]?.n ?? 0);
}

// ---------------------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------------------

/** Null when the note is gone — a reply to nothing is refused, not orphaned. */
export async function addComment(
  db: ReadDb,
  noteId: number,
  input: CommentInput,
  now: number = Date.now(),
): Promise<Comment | null> {
  const exists = await driver(db).select({ id: notes.id }).from(notes).where(eq(notes.id, noteId)).all();
  if (exists.length === 0) return null;
  const rows = await driver(db)
    .insert(noteComments)
    .values({ noteId, body: input.body, author: input.author || null, createdAt: new Date(now) })
    .returning()
    .all();
  return rows[0]!;
}

export async function deleteComment(db: ReadDb, id: number): Promise<boolean> {
  const rows = await driver(db)
    .delete(noteComments)
    .where(eq(noteComments.id, id))
    .returning({ id: noteComments.id })
    .all();
  return rows.length > 0;
}
