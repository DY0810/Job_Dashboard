'use client';

import { useEffect, useRef, useState } from 'react';

import type { Note } from '@/lib/notes';
import { Close } from '../icons';
import { SEEN_KEY } from '../talkie-badge';

const MIN = { w: 120, h: 80 };
const MAX = { w: 800, h: 600 };
const AUTHOR_KEY = 'talkie-author';

type Rect = { x: number; y: number; w: number; h: number };

/**
 * A drag on empty board draws a box — dashed, labelled with its size, faint until it is big
 * enough to read — and releasing turns the box into a note with the cursor in it. Nothing
 * animates: drawing is direct manipulation, and a note that appears where you drew it needs
 * no choreography to explain itself.
 */
export function Board({ notes: initial, canWrite }: { notes: Note[]; canWrite: boolean }) {
  const [notes, setNotes] = useState(initial);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [pending, setPending] = useState<Rect | null>(null);
  const [author, setAuthor] = useState('');
  const [mounted, setMounted] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    setMounted(true);
    setAuthor(localStorage.getItem(AUTHOR_KEY) ?? '');
    // Opening the board is what "viewed" means. The badge on the other tabs counts from here.
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  }, []);

  const point = (e: React.PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: Math.max(0, Math.round(e.clientX - r.left)), y: Math.max(0, Math.round(e.clientY - r.top)) };
  };

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canWrite || pending || e.target !== e.currentTarget || e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    origin.current = point(e);
    setDraft({ ...origin.current, w: 0, h: 0 });
  };
  const onMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!origin.current) return;
    const p = point(e);
    const o = origin.current;
    setDraft({
      x: Math.min(o.x, p.x),
      y: Math.min(o.y, p.y),
      w: Math.min(MAX.w, Math.abs(p.x - o.x)),
      h: Math.min(MAX.h, Math.abs(p.y - o.y)),
    });
  };
  const onUp = () => {
    if (draft && draft.w >= MIN.w && draft.h >= MIN.h) setPending(draft);
    origin.current = null;
    setDraft(null);
  };

  const save = async (rect: Rect, body: string) => {
    const res = await fetch('/api/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...rect, body, author: author || undefined }),
    });
    if (!res.ok) throw new Error(res.status === 429 ? 'this week is full' : 'could not save');
    const note = (await res.json()) as Note;
    setNotes((all) => [...all, { ...note, createdAt: new Date(note.createdAt), updatedAt: new Date(note.updatedAt) }]);
    setPending(null);
    localStorage.setItem(SEEN_KEY, String(Date.now()));
  };
  const edit = async (id: number, body: string) => {
    const res = await fetch(`/api/notes/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body }),
    });
    if (!res.ok) throw new Error('could not save');
    setNotes((all) => all.map((n) => (n.id === id ? { ...n, body } : n)));
  };
  const remove = async (id: number) => {
    if (!confirm('Delete this note?')) return;
    const res = await fetch(`/api/notes/${id}`, { method: 'DELETE' });
    if (res.ok || res.status === 404) setNotes((all) => all.filter((n) => n.id !== id));
  };

  const tooSmall = draft !== null && (draft.w < MIN.w || draft.h < MIN.h);

  return (
    <div>
      <div className="flex items-baseline justify-between gap-4 border-b border-rule py-2 text-[11px] text-fg-dim">
        <span>
          {canWrite
            ? notes.length === 0 && !pending
              ? 'Nothing yet this week. Drag on the board to leave a note.'
              : 'Drag on empty board to leave a note.'
            : 'An earlier week. Notes here are kept, not edited.'}
        </span>
        {canWrite ? (
          <label className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-[0.1em]">signed as</span>
            <input
              className="w-32 border-b border-rule bg-transparent text-fg outline-none focus:border-fg-dim"
              value={author}
              maxLength={40}
              placeholder="your name"
              onChange={(e) => {
                setAuthor(e.target.value);
                localStorage.setItem(AUTHOR_KEY, e.target.value);
              }}
            />
          </label>
        ) : null}
      </div>

      <div
        className="board"
        data-readonly={canWrite ? undefined : ''}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        role="region"
        aria-label="Notes board"
      >
        {notes.map((note) => (
          <NoteCard
            key={note.id}
            note={note}
            mounted={mounted}
            canWrite={canWrite}
            onEdit={(body) => edit(note.id, body)}
            onDelete={() => remove(note.id)}
          />
        ))}

        {pending ? (
          <NoteEditor rect={pending} onSave={(body) => save(pending, body)} onCancel={() => setPending(null)} />
        ) : null}

        {draft ? (
          <div
            className={tooSmall ? 'draft draft-small' : 'draft'}
            style={{ left: draft.x, top: draft.y, width: draft.w, height: draft.h }}
            aria-hidden
          >
            <span className="draft-size">
              {draft.w} × {draft.h}
              {tooSmall ? ` · min ${MIN.w} × ${MIN.h}` : ''}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function NoteCard({
  note, mounted, canWrite, onEdit, onDelete,
}: {
  note: Note; mounted: boolean; canWrite: boolean;
  onEdit: (body: string) => Promise<void>; onDelete: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const when = mounted
    ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(note.createdAt)
    : '';

  if (editing) {
    return (
      <NoteEditor
        rect={note}
        initial={note.body}
        onSave={async (body) => { await onEdit(body); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }
  return (
    <div className="note" style={{ left: note.x, top: note.y, width: note.w, height: note.h }}>
      <div
        className="note-body"
        tabIndex={canWrite ? 0 : -1}
        onClick={() => canWrite && setEditing(true)}
        onKeyDown={(e) => canWrite && e.key === 'Enter' && setEditing(true)}
      >
        {note.body}
      </div>
      <div className="note-meta">
        {note.author ? <span>{note.author}</span> : null}
        <time dateTime={note.createdAt.toISOString()}>{when}</time>
      </div>
      {canWrite ? (
        <button type="button" className="note-close" onClick={onDelete} aria-label="Delete note">
          <Close />
        </button>
      ) : null}
    </div>
  );
}

function NoteEditor({
  rect, initial = '', onSave, onCancel,
}: {
  rect: Rect; initial?: string; onSave: (body: string) => Promise<void>; onCancel: () => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);
  useEffect(() => ref.current?.focus(), []);

  const commit = async () => {
    if (busy.current) return;
    const body = ref.current?.value.trim() ?? '';
    if (!body) return onCancel();
    if (body === initial) return onCancel();
    busy.current = true;
    try { await onSave(body); } catch (e) { setError((e as Error).message); busy.current = false; }
  };

  return (
    <div className="note note-editing" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }}>
      <textarea
        ref={ref}
        defaultValue={initial}
        maxLength={1000}
        placeholder="Type, then click away to save. Esc discards."
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(); }
        }}
      />
      {error ? <div className="note-meta text-accent">{error}</div> : null}
    </div>
  );
}
