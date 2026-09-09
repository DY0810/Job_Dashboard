'use client';

import { useEffect, useRef, useState } from 'react';

import type { Comment, NoteWithComments } from '@/lib/notes';
import { Close } from '../icons';
import { SEEN_KEY } from '../talkie-badge';
import {
  clearEditDraft,
  clearNewNoteDraft,
  clearTalkieToken,
  readEditDraft,
  readNewNoteDraft,
  readTalkieAuthor,
  readTalkieToken,
  saveEditDraft,
  saveNewNoteDraft,
  saveTalkieAuthor,
  saveTalkieToken,
  type NewNoteDraft,
} from './storage';
import { DeferredEditWriter, sameNoteDraft, shouldAttachServerId } from './autosave';

const MIN = { w: 120, h: 80 };
const MAX = { w: 800, h: 600 };
type Rect = { x: number; y: number; w: number; h: number };
type Edge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
/** The same drag machinery moves a note; `move` is checked before any edge test. */
type Grab = Edge | 'move';
const EDGES: Edge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

class TokenError extends Error {}

async function call<T>(url: string, init: RequestInit, token: string | null, fallback: string): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(token ? { 'x-workie-token': token } : {}),
      ...init.headers,
    },
  });
  if (res.status === 401) throw new TokenError('a write token is needed to change this board');
  if (res.status === 503) throw new Error('writes are not configured on this deployment');
  if (!res.ok) throw new Error(res.status === 429 ? 'this week is full' : fallback);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

function newClientKey(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

/**
 * A drag on empty board draws a box — dashed, labelled with its size, faint until it is big
 * enough to read — and releasing turns the box into a note with the cursor in it. The drag
 * decides a note's WIDTH; its height follows whatever it holds, replies included, so nothing
 * is ever clipped behind a scrollbar. Nothing animates: drawing is direct manipulation.
 */
export function Board({ notes: initial, canWrite, week }: { notes: NoteWithComments[]; canWrite: boolean; week: string }) {
  const [notes, setNotes] = useState(initial);
  const [draft, setDraft] = useState<Rect | null>(null);
  const [pending, setPending] = useState<NewNoteDraft | null>(null);
  const [pendingServerId, setPendingServerId] = useState<number | null>(null);
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [storageWarning, setStorageWarning] = useState<string | null>(null);
  const [author, setAuthor] = useState('');
  const [tokenForm, setTokenForm] = useState(false);
  const [token, setToken] = useState('');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [retryWrites, setRetryWrites] = useState(0);
  const [mounted, setMounted] = useState(false);
  const origin = useRef<{ x: number; y: number } | null>(null);
  const createTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const createInFlight = useRef<{ clientKey: string; promise: Promise<void> } | null>(null);
  const pendingRef = useRef<NewNoteDraft | null>(null);
  const pendingServerIdRef = useRef<number | null>(null);
  const replacePending = (next: NewNoteDraft | null) => {
    pendingRef.current = next;
    setPending(next);
  };
  const replacePendingServerId = (next: number | null) => {
    pendingServerIdRef.current = next;
    setPendingServerId(next);
  };

  useEffect(() => {
    setMounted(true);
    setAuthor(readTalkieAuthor());
    if (canWrite) replacePending(readNewNoteDraft(week));
    // Opening the board is what "viewed" means. The badge on the other tabs counts from here.
    try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {}
    return () => { if (createTimer.current) clearTimeout(createTimer.current); };
  }, [canWrite, week]);

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
    if (draft && draft.w >= MIN.w && draft.h >= MIN.h) {
      const pendingDraft: NewNoteDraft = { ...draft, h: 0, body: '', week, clientKey: newClientKey() };
      replacePending(pendingDraft);
      setPendingError(null);
      if (!saveNewNoteDraft(pendingDraft)) {
        setStorageWarning('Browser storage is unavailable; keep this tab open until the note saves.');
      }
    }
    origin.current = null;
    setDraft(null);
  };

  const patch = (id: number, fn: (n: NoteWithComments) => NoteWithComments) =>
    setNotes((all) => all.map((n) => (n.id === id ? fn(n) : n)));
  const touch = () => { try { localStorage.setItem(SEEN_KEY, String(Date.now())); } catch {} };
  const write = async <T,>(url: string, init: RequestInit, fallback: string): Promise<T> => {
    try {
      return await call<T>(url, init, sessionToken ?? readTalkieToken(), fallback);
    } catch (error) {
      if (error instanceof TokenError) {
        clearTalkieToken();
        setSessionToken(null);
        setTokenForm(true);
      }
      throw error;
    }
  };

  const save = (pendingDraft: NewNoteDraft, keepEditor: boolean): Promise<void> => {
    const body = pendingDraft.body.trim();
    if (!body) return Promise.resolve();
    const active = createInFlight.current;
    if (active?.clientKey === pendingDraft.clientKey) {
      if (keepEditor) return active.promise;
      return active.promise.then(() => {
        const latest = pendingRef.current;
        if (latest?.clientKey === pendingDraft.clientKey) return save(latest, false);
      });
    }

    let retry: NewNoteDraft | null = null;
    const fields = (value: NewNoteDraft) => ({
      body: value.body.trim(), x: value.x, y: value.y, w: value.w, h: value.h,
    });
    const work = (async () => {
      try {
        const priorId = pendingServerIdRef.current;
        const note = priorId === null
          ? await write<NoteWithComments>('/api/notes', {
              method: 'POST',
              body: JSON.stringify({ ...pendingDraft, body, author: author || undefined }),
            }, 'could not save')
          : await write<NoteWithComments>(
              `/api/notes/${priorId}`,
              { method: 'PATCH', body: JSON.stringify(fields(pendingDraft)) },
              'could not save',
            );
        if (shouldAttachServerId(pendingRef.current?.clientKey, pendingDraft.clientKey)) {
          replacePendingServerId(note.id);
        }
        let normalized = { ...note, createdAt: new Date(note.createdAt), updatedAt: new Date(note.updatedAt), comments: [] as Comment[] };
        const newer = pendingRef.current;
        if (newer?.clientKey === pendingDraft.clientKey && newer.body.trim() && !sameNoteDraft(newer, normalized)) {
          const updated = await write<NoteWithComments>(
            `/api/notes/${note.id}`,
            { method: 'PATCH', body: JSON.stringify(fields(newer)) },
            'could not save',
          );
          normalized = { ...updated, createdAt: new Date(updated.createdAt), updatedAt: new Date(updated.updatedAt), comments: [] };
        }
        setNotes((all) =>
          all.some((existing) => existing.id === normalized.id)
            ? all.map((existing) => (
                existing.id === normalized.id ? { ...normalized, comments: existing.comments } : existing
              ))
            : [...all, normalized],
        );
        const current = pendingRef.current;
        if (current?.clientKey === pendingDraft.clientKey) {
          if (sameNoteDraft(current, normalized)) {
            if (!keepEditor) {
              clearNewNoteDraft(pendingDraft.clientKey);
              replacePending(null);
              replacePendingServerId(null);
            }
          } else if (current.body.trim()) {
            retry = current;
          }
          setPendingError(null);
          setStorageWarning(null);
        }
        touch();
      } finally {
        if (createInFlight.current?.clientKey === pendingDraft.clientKey) createInFlight.current = null;
        if (retry) scheduleSave(retry);
      }
    })();
    createInFlight.current = { clientKey: pendingDraft.clientKey, promise: work };
    return work;
  };
  const scheduleSave = (pendingDraft: NewNoteDraft) => {
    if (createTimer.current) clearTimeout(createTimer.current);
    if (!pendingDraft.body.trim()) return;
    createTimer.current = setTimeout(() => {
      void save(pendingDraft, true).catch((error) => {
        if (pendingRef.current?.clientKey === pendingDraft.clientKey) setPendingError((error as Error).message);
      });
    }, 700);
  };
  useEffect(() => {
    if (pending?.body.trim()) scheduleSave(pending);
    // A restored draft gets its first autosave after mount. A newly supplied token retries
    // it too; body changes schedule directly through `updatePending`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending?.clientKey, retryWrites]);
  const updatePending = (next: NewNoteDraft, autosave: boolean = true) => {
    replacePending(next);
    if (!saveNewNoteDraft(next)) {
      setStorageWarning('Browser storage is unavailable; keep this tab open until the note saves.');
    }
    if (autosave) scheduleSave(next);
  };
  const edit = async (id: number, body: string) => {
    await write(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify({ body }) }, 'could not save');
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
      await write(`/api/notes/${id}`, { method: 'PATCH', body: JSON.stringify(geometry) }, 'could not resize');
    } catch (error) {
      patch(id, (n) => ({ ...n, ...previous }));
      throw error;
    }
  };
  const remove = async (id: number) => {
    await write(`/api/notes/${id}`, { method: 'DELETE' }, 'could not delete');
    setNotes((all) => all.filter((n) => n.id !== id));
  };
  const reply = async (id: number, body: string) => {
    const comment = await write<Comment>(`/api/notes/${id}/comments`, {
      method: 'POST', body: JSON.stringify({ body, author: author || undefined }),
    }, 'could not reply');
    patch(id, (n) => ({ ...n, comments: [...n.comments, { ...comment, createdAt: new Date(comment.createdAt) }] }));
    touch();
  };
  const unreply = async (id: number, cid: number) => {
    await write(`/api/notes/${id}/comments/${cid}`, { method: 'DELETE' }, 'could not delete');
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
              onChange={(e) => { setAuthor(e.target.value); saveTalkieAuthor(e.target.value); }}
            />
          </label>
        ) : null}
      </div>

      {tokenForm ? (
        <form
          aria-label="Talkie write token"
          className="flex flex-wrap items-end gap-2 border-b border-rule py-2"
          onSubmit={(event) => {
            event.preventDefault();
            const next = token.trim();
            if (!next) return;
            setSessionToken(next);
            saveTalkieToken(next);
            setToken('');
            setTokenForm(false);
            setRetryWrites((version) => version + 1);
          }}
        >
          <label className="flex min-w-48 flex-1 flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">write token</span>
            <input
              autoFocus
              required
              type="password"
              autoComplete="off"
              className="border-b border-rule bg-transparent text-fg outline-none focus:border-fg-dim"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <button type="submit" className="chip">save token</button>
          <button type="button" className="chip" onClick={() => setTokenForm(false)}>cancel</button>
        </form>
      ) : null}

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
        {notes.filter((note) => note.id !== pendingServerId).map((note) => (
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
            retryWrites={retryWrites}
          />
        ))}

        {pending ? (
          <NoteEditor
            key={pending.clientKey}
            rect={pending}
            initial={pending.body}
            error={pendingError ?? storageWarning}
            saved={notes.some((note) => note.id === pendingServerId && sameNoteDraft(pending, note))}
            onChange={(body) => updatePending({ ...pending, body })}
            onMove={(at) => updatePending({ ...pending, ...at })}
            onSave={async (body) => {
              const next = { ...pending, body };
              updatePending(next, false);
              await save(next, false);
            }}
            onCancel={() => {
              if (createTimer.current) clearTimeout(createTimer.current);
              clearNewNoteDraft(pending.clientKey);
              replacePending(null);
              replacePendingServerId(null);
              setPendingError(null);
            }}
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
  note, mounted, canWrite, onEdit, onResize, onDelete, onReply, onUnreply, retryWrites,
}: {
  note: NoteWithComments; mounted: boolean; canWrite: boolean;
  onEdit: (body: string) => Promise<void>; onResize: (geometry: Partial<Rect>) => Promise<void>; onDelete: () => Promise<void>;
  onReply: (body: string) => Promise<void>; onUnreply: (cid: number) => Promise<void>; retryWrites: number;
}) {
  const [editing, setEditing] = useState(false);
  const [draftBody, setDraftBody] = useState(note.body);
  const [error, setError] = useState<string | null>(null);
  const replyRef = useRef<HTMLInputElement>(null);
  const latestDraft = useRef(note.body);
  const onEditRef = useRef(onEdit);
  onEditRef.current = onEdit;
  const writer = useRef<DeferredEditWriter | null>(null);
  const ensureWriter = () => {
    if (!writer.current) {
      writer.current = new DeferredEditWriter(note.body, {
        delayMs: 700,
        write: (body) => onEditRef.current(body),
        onAcknowledged: (body) => {
          if (latestDraft.current.trim() === body) clearEditDraft(note.id);
          setError(null);
        },
        onError: (err) => setError((err as Error).message),
      });
    }
    return writer.current;
  };

  useEffect(() => {
    if (!canWrite) {
      setEditing(false);
      return;
    }
    const recovered = readEditDraft(note.id);
    if (recovered !== null) {
      latestDraft.current = recovered;
      setDraftBody(recovered);
      setEditing(true);
      ensureWriter().setDesired(recovered);
    } else {
      latestDraft.current = note.body;
      setDraftBody(note.body);
    }
    return () => {
      writer.current?.dispose();
      writer.current = null;
    };
    // Note-body acknowledgements must not dispose a timer for newer local text.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite, note.id]);

  useEffect(() => {
    if (!editing || !readEditDraft(note.id) || !draftBody.trim()) return;
    ensureWriter().retry();
    // Token submission changes `retryWrites`; recovery gets one retry without requiring
    // another keystroke. Normal edits are scheduled by `onChange` below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, retryWrites]);

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
        initial={draftBody}
        error={error}
        saved={draftBody.trim() === note.body.trim()}
        onMove={(at) => { void onResize(at).catch((err) => setError((err as Error).message)); }}
        onChange={(body) => {
          latestDraft.current = body;
          setDraftBody(body);
          if (!saveEditDraft(note.id, body)) {
            setError('Browser storage is unavailable; keep this tab open until the note saves.');
          }
          ensureWriter().setDesired(body);
        }}
        onSave={async (body) => {
          latestDraft.current = body;
          ensureWriter().setDesired(body);
          await ensureWriter().flush();
          setEditing(false);
        }}
        onCancel={() => {
          clearEditDraft(note.id);
          writer.current?.dispose();
          writer.current = null;
          latestDraft.current = note.body;
          setDraftBody(note.body);
          setEditing(false);
        }}
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
  const removeNote = async () => {
    try {
      await onDelete();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const removeReply = async (cid: number) => {
    try {
      await onUnreply(cid);
    } catch (err) {
      setError((err as Error).message);
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
            <button type="button" className="note-action" onClick={() => {
              latestDraft.current = note.body;
              setDraftBody(note.body);
              setEditing(true);
            }}>
              edit
            </button>
            <button type="button" className="note-action" onClick={() => { void removeNote(); }}>
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
                  <button type="button" className="comment-close" onClick={() => { void removeReply(comment.id); }} aria-label="Delete reply">
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
          {error ? <div className="note-meta">{error}</div> : null}
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
  rect, initial = '', error: externalError = null, saved = false, onSave, onCancel, onMove, onChange,
}: {
  rect: Rect; initial?: string; onSave: (body: string) => Promise<void>; onCancel: () => void;
  /** Where the note was let go. The parent decides whether that is a draft or a save. */
  onMove?: (at: { x: number; y: number }) => void;
  onChange?: (body: string) => void;
  error?: string | null;
  saved?: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(initial);
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
  useEffect(() => {
    setBody(initial);
    ref.current?.focus();
    fit();
  }, [initial]);

  const commit = async () => {
    if (busy.current) return;
    const value = body.trim();
    if (!value) return onCancel();
    busy.current = true;
    try {
      await onSave(value);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      busy.current = false;
    }
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
      {/* Typing saves after a short pause; Enter flushes now, Shift+Enter is a new line, and
          Esc intentionally discards the local draft. Clicking away leaves recovery intact. */}
      <textarea
        ref={ref}
        value={body}
        maxLength={1000}
        rows={1}
        aria-label="Note"
        placeholder="Write a note"
        onChange={(event) => {
          setError(null);
          setBody(event.target.value);
          onChange?.(event.target.value);
          requestAnimationFrame(fit);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commit(); }
        }}
      />
      <div className="note-meta flex items-center justify-between gap-2">
        {error || externalError ? (
          <span role="alert">{error ?? externalError}</span>
        ) : (
          <span role="status">{saved ? 'saved' : body.trim() ? 'saving...' : 'draft'}</span>
        )}
        <button type="button" className="note-action" onClick={() => { void commit(); }}>done</button>
      </div>
    </div>
  );
}
