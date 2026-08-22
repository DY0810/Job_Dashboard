/**
 * Talkie notes: the interface is the test surface. Week math is ISO 8601 in UTC — the server
 * runs in UTC on Vercel, so "this week" means the same thing on the laptop and the hosted board.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { describe, expect, it } from 'vitest';

import type { Db } from './db/index.ts';
import {
  CommentInput, MAX_NOTES_PER_WEEK, NoteInput, addComment, countActivitySince, createNote,
  deleteComment, deleteNote, listNotes, listWeeks, updateNote, weekKey, weekLabel, weekRange,
} from './notes.ts';

function memoryDb(): Db {
  const db = drizzle(new Database(':memory:')) as unknown as Db;
  migrate(db, { migrationsFolder: 'drizzle' });
  return db;
}
const T = (iso: string) => Date.parse(iso);
const NOTE = { body: 'ship the Talkie tab', author: 'dyl', x: 40, y: 60, w: 240, h: 160 };

describe('ISO weeks, in UTC', () => {
  it('buckets a date into its ISO week', () => {
    expect(weekKey(new Date('2026-08-20T12:00:00Z'))).toBe('2026-W34');
    expect(weekKey(new Date('2026-08-23T23:59:59Z'))).toBe('2026-W34'); // Sunday, still W34
    expect(weekKey(new Date('2026-08-24T00:00:00Z'))).toBe('2026-W35'); // Monday
  });

  it('handles the year boundary the way ISO does', () => {
    expect(weekKey(new Date('2026-01-01T00:00:00Z'))).toBe('2026-W01'); // week 1 starts 2025-12-29
    expect(weekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53'); // Friday before ISO 2027
  });

  it('ranges are half-open Monday-to-Monday and round-trip the key', () => {
    const { start, end } = weekRange('2026-W34')!;
    expect(new Date(start).toISOString()).toBe('2026-08-17T00:00:00.000Z');
    expect(new Date(end).toISOString()).toBe('2026-08-24T00:00:00.000Z');
    expect(weekKey(new Date(start))).toBe('2026-W34');
    expect(weekKey(new Date(end - 1))).toBe('2026-W34');
  });

  it('rejects a malformed key instead of guessing', () => {
    expect(weekRange('2026-W99')).toBeNull();
    expect(weekRange('week-34')).toBeNull();
  });

  it('labels a week by its dates, which is what a calendar shows', () => {
    expect(weekLabel('2026-W34')).toBe('Aug 17 – 23');
    expect(weekLabel('2026-W53')).toBe('Dec 28 – Jan 3');
  });
});

describe('validation at the public write seam', () => {
  it('accepts a sane note and trims the body', () => {
    const parsed = NoteInput.safeParse({ ...NOTE, body: '  hello  ' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.body).toBe('hello');
  });

  it.each([
    ['empty body', { ...NOTE, body: '   ' }],
    ['body over 1000 chars', { ...NOTE, body: 'x'.repeat(1001) }],
    ['author over 40 chars', { ...NOTE, author: 'a'.repeat(41) }],
    ['negative position', { ...NOTE, x: -1 }],
    ['a note too small to read', { ...NOTE, w: 20 }],
    ['a note the size of the board', { ...NOTE, w: 5000 }],
  ])('rejects %s', (_label, input) => {
    expect(NoteInput.safeParse(input).success).toBe(false);
  });
});

describe('the board', () => {
  it('creates, lists by week, and never shows another week', async () => {
    const db = memoryDb();
    const a = await createNote(db, NOTE, T('2026-08-20T10:00:00Z'));
    await createNote(db, { ...NOTE, body: 'last week' }, T('2026-08-12T10:00:00Z'));

    const thisWeek = await listNotes(db, '2026-W34');
    expect(thisWeek.map((n) => n.body)).toEqual(['ship the Talkie tab']);
    expect(thisWeek[0]).toMatchObject({ id: a.id, author: 'dyl', x: 40, y: 60, w: 240, h: 160 });
    expect((await listNotes(db, '2026-W33')).map((n) => n.body)).toEqual(['last week']);
    expect(await listNotes(db, '2026-W30')).toEqual([]);
  });

  it('lists the weeks that have notes, newest first', async () => {
    const db = memoryDb();
    await createNote(db, NOTE, T('2026-08-12T10:00:00Z'));
    await createNote(db, NOTE, T('2026-08-20T10:00:00Z'));
    await createNote(db, NOTE, T('2026-08-21T10:00:00Z'));
    expect(await listWeeks(db)).toEqual(['2026-W34', '2026-W33']);
  });

  it('edits keep their position and bump updated_at; deletes are real', async () => {
    const db = memoryDb();
    const a = await createNote(db, NOTE, T('2026-08-20T10:00:00Z'));
    const edited = await updateNote(db, a.id, 'ship it today', T('2026-08-20T11:00:00Z'));
    expect(edited).toMatchObject({ body: 'ship it today', x: 40, y: 60 });
    expect(edited!.updatedAt.getTime()).toBe(T('2026-08-20T11:00:00Z'));
    expect(await updateNote(db, 999, 'ghost', T('2026-08-20T11:00:00Z'))).toBeNull();

    expect(await deleteNote(db, a.id)).toBe(true);
    expect(await deleteNote(db, a.id)).toBe(false);
    expect(await listNotes(db, '2026-W34')).toEqual([]);
  });

  it('counts what a viewer has not seen — notes AND replies, strictly after their cursor', async () => {
    const db = memoryDb();
    const a = await createNote(db, NOTE, T('2026-08-20T10:00:00Z'));
    await createNote(db, NOTE, T('2026-08-20T12:00:00Z'));
    await addComment(db, a.id, { body: 'on it', author: 'sam' }, T('2026-08-20T13:00:00Z'));
    expect(await countActivitySince(db, T('2026-08-20T10:00:00Z'))).toBe(2); // one note, one reply
    expect(await countActivitySince(db, 0)).toBe(3);
    expect(await countActivitySince(db, T('2026-08-20T13:00:00Z'))).toBe(0);
  });

  it('publishes the per-week cap the public route enforces', () => {
    expect(MAX_NOTES_PER_WEEK).toBeGreaterThanOrEqual(100);
  });
});


describe('comments', () => {
  it('thread under a note, oldest first, and come back with the note', async () => {
    const db = memoryDb();
    const a = await createNote(db, NOTE, T('2026-08-20T10:00:00Z'));
    await addComment(db, a.id, { body: 'second', author: 'sam' }, T('2026-08-20T11:00:00Z'));
    await addComment(db, a.id, { body: 'first' }, T('2026-08-20T10:30:00Z'));

    const [note] = await listNotes(db, '2026-W34');
    expect(note.comments.map((c) => c.body)).toEqual(['first', 'second']);
    expect(note.comments[1]).toMatchObject({ author: 'sam', noteId: a.id });
  });

  it('validates at the seam like a note does', () => {
    expect(CommentInput.safeParse({ body: '  ok  ' }).success).toBe(true);
    expect(CommentInput.safeParse({ body: '   ' }).success).toBe(false);
    expect(CommentInput.safeParse({ body: 'x'.repeat(501) }).success).toBe(false);
    expect(CommentInput.safeParse({ body: 'x', author: 'a'.repeat(41) }).success).toBe(false);
  });

  it('refuses to comment on a note that does not exist', async () => {
    const db = memoryDb();
    expect(await addComment(db, 999, { body: 'ghost' }, T('2026-08-20T10:00:00Z'))).toBeNull();
  });

  it('deletes one, and deletes them all with their note', async () => {
    const db = memoryDb();
    const a = await createNote(db, NOTE, T('2026-08-20T10:00:00Z'));
    const c1 = (await addComment(db, a.id, { body: 'one' }, T('2026-08-20T11:00:00Z')))!;
    await addComment(db, a.id, { body: 'two' }, T('2026-08-20T12:00:00Z'));

    expect(await deleteComment(db, c1.id)).toBe(true);
    expect(await deleteComment(db, c1.id)).toBe(false);
    expect((await listNotes(db, '2026-W34'))[0].comments.map((c) => c.body)).toEqual(['two']);

    await deleteNote(db, a.id);
    expect(await countActivitySince(db, 0)).toBe(0); // no orphaned replies counted as activity
  });
});
