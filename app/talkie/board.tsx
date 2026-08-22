'use client';

import { useEffect, useRef, useState } from 'react';

import type { Comment, NoteWithComments } from '@/lib/notes';
import { Close } from '../icons';
import { SEEN_KEY } from '../talkie-badge';

const MIN = { w: 120, h: 80 };
const MAX = { w: 800, h: 600 };
const AUTHOR_KEY = 'talkie-author';

type Rect = { x: number; y: number; w: number; h: number };

async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const res = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
  if (!res.ok) throw new Error(res.status === 429 ? 'this week is full' : fallback);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/**
 * A drag on empty board draws a box — dashed, labelled with its size, faint until it is big
 * enough to read — and releasing turns the box into a note with the cursor in it. The drag
 * decides a note's WIDTH; its height follows whatever it holds, replies included, so nothing
 * is ever clipped behind a scrollbar. Nothing animates: drawing is direct manipulation.
 */
export function Board({ notes: initial, canWrite }: { notes: NoteWithComments[]; canWrite: boolean }) {
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

  const patch = (id: number, fn: (n: NoteWithComments) => NoteWithComments) =>
    setNotes((all) => all.map((n) => (n.id === id ? fn(n) : n)));
  const touch = () => localStorage.setItem(SEEN_KEY, String(Date.now()));

  const save = async (rect: Rect, body: string) => {
    const note = await call<NoteWithComments>('/api/notes', {
      method: 'POST', body: JSON.stringify({ ...rect, body, author: author || undefined }),
    }, 'could not save');
    setNotes((all) => [...all, { ...note, createdAt: new Date(note.createdAt), updatedAt: new Date(note.updatedAt), comments: [] }]);
    setPending(null);
    touch();
  };
  const edit = async (id: number, body: string) => {
    await call(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) }, 'could not save');
    patch(id, (n) => ({ ...n, body }));
  };
  const remove = async (id: number) => {
    if (!confirm('Delete this note and its replies?')) return;
    await call(`/api/notes/${id}`, { method: 'DELETE' }, 'could not delete').catch(() => {});
    setNotes((all) => all.filter((n) => n.id !== id));
  };
  const reply = async (id: number, body: string) => {
    const comment = await call<Comment>(`/api/notes/${id}/comments`, {
      method: 'POST', body: JSON.stringify({ body, author: author || undefined }),
    }, 'could not reply');
    patch(id, (n) => ({ ...n, comments: [...n.comments, { ...comment, createdAt: new Date(comment.createdAt) }] }));
    touch();
  };
  const unreply = async (id: number, cid: number) => {
    await call(`/api/notes/${id}/comments/${cid}`, { method: 'DELETE' }, 'could not delete').catch(() => {});
    patch(id, (n) => ({ ...n, comments: n.comments.filter((c) => c.id !== cid) }));
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
              onChange={(e) => { setAuthor(e.target.value); localStorage.setItem(AUTHOR_KEY, e.target.value); }}
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
            onReply={(body) => reply(note.id, body)}
            onUnreply={(cid) => unreply(note.id, cid)}
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

function When({ at, mounted }: { at: Date; mounted: boolean }) {
  // Formatted after mount: the server renders in UTC and the reader is not in UTC.
  const text = mounted
    ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at)
    : '';
  return <time dateTime={at.toISOString()}>{text}</time>;
}

function NoteCard({
  note, mounted, canWrite, onEdit, onDelete, onReply, onUnreply,
}: {
  note: NoteWithComments; mounted: boolean; canWrite: boolean;
  onEdit: (body: string) => Promise<void>; onDelete: () => void;
  onReply: (body: string) => Promise<void>; onUnreply: (cid: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replyRef = useRef<HTMLInputElement>(null);

  if (editing) {
    return (
      <NoteEditor
        rect={{ ...note, h: 0 }}
        initial={note.body}
        onSave={async (body) => { await onEdit(body); setEditing(false); }}
        onCancel={() => setEditing(false)}
      />
    );
  }

  const submitReply = async () => {
    const body = replyRef.current?.value.trim() ?? '';
    if (!body) return;
    try {
      await onReply(body);
      if (replyRef.current) replyRef.current.value = '';
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="note" style={{ left: note.x, top: note.y, width: note.w }}>
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
        <When at={note.createdAt} mounted={mounted} />
        {canWrite ? (
          <button type="button" className="note-delete" onClick={onDelete}>
            delete
          </button>
        ) : null}
      </div>

      {note.comments.length > 0 || canWrite ? (
        <div className="comments">
          {note.comments.map((comment) => (
            <div key={comment.id} className="comment">
              <span className="comment-body">
                {comment.author ? <span className="comment-author">{comment.author} </span> : null}
                {comment.body}
              </span>
              <span className="comment-meta">
                <When at={comment.createdAt} mounted={mounted} />
                {canWrite ? (
                  <button type="button" className="comment-close" onClick={() => onUnreply(comment.id)} aria-label="Delete reply">
                    <Close />
                  </button>
                ) : null}
              </span>
            </div>
          ))}
          {canWrite ? (
            <input
              ref={replyRef}
              className="reply"
              placeholder={note.comments.length ? 'reply…' : 'reply to this note…'}
              maxLength={500}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void submitReply(); } }}
            />
          ) : null}
          {error ? <div className="note-meta text-accent">{error}</div> : null}
        </div>
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

  // The box fits its text: the textarea grows with every keystroke and never scrolls.
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  };
  useEffect(() => { ref.current?.focus(); fit(); }, []);

  const commit = async () => {
    if (busy.current) return;
    const body = ref.current?.value.trim() ?? '';
    if (!body || body === initial) return onCancel();
    busy.current = true;
    try { await onSave(body); } catch (e) { setError((e as Error).message); busy.current = false; }
  };

  return (
    <div className="note note-editing" style={{ left: rect.x, top: rect.y, width: rect.w, minHeight: rect.h || undefined }}>
      {/* Enter commits; Shift+Enter is a new line; Esc discards. Clicking away does nothing —
          the draft stays open with its text, waiting. Saving on blur meant a stray click
          published a half-written note. */}
      <textarea
        ref={ref}
        defaultValue={initial}
        maxLength={1000}
        rows={1}
        placeholder="Type, then Enter to save. Shift+Enter for a new line. Esc discards."
        onInput={fit}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commit(); }
        }}
      />
      {error ? <div className="note-meta text-accent">{error}</div> : null}
    </div>
  );
}
