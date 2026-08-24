'use client';

import { useEffect, useRef, useState } from 'react';

import type { Comment, NoteWithComments } from '@/lib/notes';
import { Close } from '../icons';
import { SEEN_KEY } from '../talkie-badge';

const MIN = { w: 120, h: 80 };
const MAX = { w: 800, h: 600 };
const AUTHOR_KEY = 'talkie-author';
const TOKEN_KEY = 'talkie-token';

type Rect = { x: number; y: number; w: number; h: number };
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** The same drag machinery moves a note; `move` is checked before any edge test. */
type Grab = Edge | 'move';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * Every write goes through here, so the write token is attached in exactly one place.
 *
 * The token is what the server checks instead of an account. It is asked for once, on the
 * first 401, and kept in this browser — the same shape as the author name beside it. A wrong
 * or missing token is cleared so the next attempt asks again rather than failing silently.
 */
async function call<T>(url: string, init: RequestInit, fallback: string): Promise<T> {
  const send = (token: string | null) =>
    fetch(url, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { 'x-workie-token': token } : {}),
        ...init.headers,
      },
    });

  let res = await send(localStorage.getItem(TOKEN_KEY));
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    const entered = window.prompt('Write token for this board:')?.trim();
    if (!entered) throw new Error('a write token is needed to change this board');
    localStorage.setItem(TOKEN_KEY, entered);
    res = await send(entered);
    if (res.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      throw new Error('that token was not accepted');
    }
  }
  if (res.status === 503) throw new Error('writes are not configured on this deployment');
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
      // h: 0 — the drawn height sized the editor; the saved note fits its text until a
      // top or bottom grip sets a minimum.
      method: 'POST', body: JSON.stringify({ ...rect, h: 0, body, author: author || undefined }),
    }, 'could not save');
    setNotes((all) => [...all, { ...note, createdAt: new Date(note.createdAt), updatedAt: new Date(note.updatedAt), comments: [] }]);
    setPending(null);
    touch();
  };
  const edit = async (id: number, body: string) => {
    await call(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) }, 'could not save');
    patch(id, (n) => ({ ...n, body }));
  };
  // No confirmation, at the user's request: delete means delete. The control is quiet and
  // sits in the meta row rather than under the pointer's natural path, which is the only
  // guard against a stray click — there is no undo.
  const resize = async (id: number, geometry: Partial<Rect>) => {
    // Optimistic, in the same render that drops the live size: the note stays the size it
    // was let go at. Waiting for the server first showed the old size for a round trip,
    // then jumped. If the save fails the old geometry comes back, with the error.
    let previous: Partial<Rect> = {};
    patch(id, (n) => {
      previous = { x: n.x, y: n.y, w: n.w, h: n.h };
      return { ...n, ...geometry };
    });
    try {
      await call(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(geometry) }, 'could not resize');
    } catch (error) {
      patch(id, (n) => ({ ...n, ...previous }));
      throw error;
    }
  };
  const remove = async (id: number) => {
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
            onResize={(geometry) => resize(note.id, geometry)}
            onDelete={() => remove(note.id)}
            onReply={(body) => reply(note.id, body)}
            onUnreply={(cid) => unreply(note.id, cid)}
          />
        ))}

        {pending ? (
          <NoteEditor
            rect={pending}
            onMove={(at) => setPending((cur) => (cur ? { ...cur, ...at } : cur))}
            onSave={(body) => save(pending, body)}
            onCancel={() => setPending(null)}
          />
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
  note, mounted, canWrite, onEdit, onResize, onDelete, onReply, onUnreply,
}: {
  note: NoteWithComments; mounted: boolean; canWrite: boolean;
  onEdit: (body: string) => Promise<void>; onResize: (geometry: Partial<Rect>) => Promise<void>; onDelete: () => void;
  onReply: (body: string) => Promise<void>; onUnreply: (cid: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const replyRef = useRef<HTMLInputElement>(null);

  // Resizing after the fact: every edge and corner is a grip. Right/left change the width
  // (left moves the note as it shrinks); bottom/top set a MINIMUM height (top moves it) —
  // the text still grows the note past that, so auto-fit survives. Live while dragging,
  // saved on release, snapped back if the save fails.
  const cardRef = useRef<HTMLDivElement>(null);
  const [live, setLive] = useState<Rect | null>(null);
  const grip = useRef<{ edge: Grab; startX: number; startY: number; start: Rect } | null>(null);
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

  // Drag the note by its chrome: padding, the meta row's empty space, the reply strip. Not
  // the body — that is selectable text now, and a drag to highlight would move the note
  // instead. Not a control, an input, or a grip; each keeps what it already does.
  const onCardDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canWrite) return;
    if ((e.target as HTMLElement).closest('.note-body, .comment, .note-grip, textarea, input, button, a')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const h = note.h || Math.round(cardRef.current?.getBoundingClientRect().height ?? MIN.h);
    grip.current = { edge: 'move', startX: e.clientX, startY: e.clientY, start: { x: note.x, y: note.y, w: note.w, h } };
    setLive(grip.current.start);
  };

  const onGripDown = (edge: Edge) => (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    // A note that fits its text has no stored height; the drag starts from what is on screen.
    const h = note.h || Math.round(cardRef.current?.getBoundingClientRect().height ?? MIN.h);
    grip.current = { edge, startX: e.clientX, startY: e.clientY, start: { x: note.x, y: note.y, w: note.w, h } };
    setLive(grip.current.start);
  };
  const onGripMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const g = grip.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.edge === 'move') {
      // Before the edge tests: `'move'.includes('e')` is true and would resize instead.
      setLive({
        x: Math.max(0, Math.round(g.start.x + dx)),
        y: Math.max(0, Math.round(g.start.y + dy)),
        w: g.start.w,
        h: g.start.h,
      });
      return;
    }
    let { x, y, w, h } = g.start;
    if (g.edge.includes('e')) w = clamp(g.start.w + dx, MIN.w, MAX.w);
    if (g.edge.includes('w')) {
      w = clamp(g.start.w - dx, MIN.w, MAX.w);
      x = g.start.x + g.start.w - w;
      if (x < 0) { x = 0; w = g.start.x + g.start.w; }
    }
    if (g.edge.includes('s')) h = clamp(g.start.h + dy, MIN.h, MAX.h);
    if (g.edge.includes('n')) {
      h = clamp(g.start.h - dy, MIN.h, MAX.h);
      y = g.start.y + g.start.h - h;
      if (y < 0) { y = 0; h = g.start.y + g.start.h; }
    }
    setLive({ x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h) });
  };
  const onGripUp = async (e: React.PointerEvent<HTMLDivElement>) => {
    e.stopPropagation();
    const g = grip.current;
    if (!g) return;
    const r = live ?? g.start;
    grip.current = null;
    const geometry: Partial<Rect> = {};
    if (r.x !== note.x) geometry.x = r.x;
    if (r.y !== note.y) geometry.y = r.y;
    if (r.w !== note.w) geometry.w = r.w;
    // Only a vertical grip turns the on-screen height into a stored minimum.
    if ((g.edge.includes('n') || g.edge.includes('s')) && r.h !== note.h) geometry.h = r.h;
    if (Object.keys(geometry).length === 0) return setLive(null);
    // The optimistic patch and the clearing of the live size land in one batched render,
    // so there is no frame in which the note is its old size.
    const saved = onResize(geometry);
    setLive(null);
    try { await saved; } catch (err) { setError((err as Error).message); }
  };

  if (editing) {
    return (
      <NoteEditor
        rect={{ ...note, h: 0 }}
        onMove={(at) => { void onResize(at); }}
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

  const r = live ?? note;
  return (
    <div
      ref={cardRef}
      className={grip.current?.edge === 'move' ? 'note note-moving' : 'note'}
      style={{ left: r.x, top: r.y, width: r.w, minHeight: (live ? live.h : note.h) || undefined }}
      onPointerDown={onCardDown}
      onPointerMove={onGripMove}
      onPointerUp={onGripUp}
      onPointerCancel={onGripUp}
    >
      {live ? <span className="note-size">{live.w} × {live.h}</span> : null}
      {/* Plain text, nothing else. It used to open the editor on click — and a drag to
          highlight ends with a click, so the selection vanished into a textarea the moment
          it was made. Editing is its own control now, beside delete. */}
      <div className="note-body">{note.body}</div>
      <div className="note-meta">
        {note.author ? <span>{note.author}</span> : null}
        <When at={note.createdAt} mounted={mounted} />
        {canWrite ? (
          <span className="note-actions">
            <button type="button" className="note-action" onClick={() => setEditing(true)}>
              edit
            </button>
            <button type="button" className="note-action" onClick={onDelete}>
              delete
            </button>
          </span>
        ) : null}
      </div>

      {note.comments.length > 0 || canWrite ? (
        <div className="comments">
          {note.comments.map((comment) => (
            <div key={comment.id} className="comment">
              <span className="comment-body">
                {comment.author ? <span className="comment-author">{comment.author}:</span> : null}
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

      {canWrite
        ? EDGES.map((edge) => (
            <div
              key={edge}
              className="note-grip"
              data-edge={edge}
              onPointerDown={onGripDown(edge)}
              onPointerMove={(ev) => { ev.stopPropagation(); onGripMove(ev); }}
              onPointerUp={onGripUp}
              onPointerCancel={onGripUp}
              aria-hidden
            />
          ))
        : null}
    </div>
  );
}

function NoteEditor({
  rect, initial = '', onSave, onCancel, onMove,
}: {
  rect: Rect; initial?: string; onSave: (body: string) => Promise<void>; onCancel: () => void;
  /** Where the note was let go. The parent decides whether that is a draft or a save. */
  onMove?: (at: { x: number; y: number }) => void;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  // A note can be moved while it is still being written. Same rule as a saved note: the
  // chrome drags, the textarea does not — it holds a cursor and a selection.
  const [live, setLive] = useState<{ x: number; y: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; x: number; y: number } | null>(null);
  const at = live ?? rect;

  const onDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!onMove) return;
    if ((e.target as HTMLElement).closest('textarea, input, button, a')) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { startX: e.clientX, startY: e.clientY, x: at.x, y: at.y };
    setLive({ x: at.x, y: at.y });
  };
  const onMoveDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    setLive({
      x: Math.max(0, Math.round(d.x + e.clientX - d.startX)),
      y: Math.max(0, Math.round(d.y + e.clientY - d.startY)),
    });
  };
  const onUp = () => {
    if (!drag.current) return;
    drag.current = null;
    // Hand the parent the position and drop the live one in the same batched render, so
    // there is no frame at the old spot — the same ordering the saved-note drag needs.
    if (live) onMove?.(live);
    setLive(null);
  };

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
    <div
      className={drag.current ? 'note note-editing note-moving' : 'note note-editing'}
      style={{ left: at.x, top: at.y, width: rect.w, minHeight: rect.h || undefined }}
      onPointerDown={onDown}
      onPointerMove={onMoveDrag}
      onPointerUp={onUp}
      onPointerCancel={onUp}
    >
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
