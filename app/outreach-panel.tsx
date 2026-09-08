'use client';

import { useEffect, useMemo, useState } from 'react';

import {
  compose,
  composeUrl,
  type Outline,
  type OutreachKind,
  type Posting,
  type Sender,
  stillQueued,
} from '@/lib/outreach';
import { clearSendToken, readSendToken, saveSendToken } from './outreach-storage';

/**
 * The compose panel: your outline on the left of the seam, the finished email on the right.
 *
 * It STRUCTURES rather than rewrites. Everything you type lands in the draft verbatim — no
 * model touches it — which is the whole reason the preview is worth showing: what you read
 * here is exactly what Gmail receives. A field you leave empty keeps its bracket, so a
 * half-finished draft still looks half-finished rather than quietly sendable.
 *
 * The seam for a future rewrite is `draft` below: it is the single place the finished text is
 * produced, so an LLM pass would wrap that one value and nothing else in this file would move.
 * Deliberately not built yet — the form is free and ships today, and it is worth finding out
 * whether it is too rigid before adding a paid dependency to a tool that has none.
 */
export function OutreachPanel({
  kind,
  posting,
  sender,
  onClose,
}: {
  kind: OutreachKind;
  posting: Posting;
  sender: Sender;
  onClose: () => void;
}) {
  const [to, setTo] = useState({ name: '', email: '' });
  const [outline, setOutline] = useState<Outline>({ fit: ['', '', ''] });
  const [queue, setQueue] = useState<{ to: string; subject: string; body: string }[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [tokenForm, setTokenForm] = useState(false);
  const [token, setToken] = useState('');
  const [sessionToken, setSessionToken] = useState<string | null>(null);
  const [canSend, setCanSend] = useState(false);
  // The server's own cap, asked for rather than duplicated: a queue the route will reject is
  // a queue with no exit, since nothing in this panel could shrink it again.
  const [maxBatch, setMaxBatch] = useState(10);

  // Asked once: whether this deployment has Gmail credentials at all. The button says why it
  // cannot send rather than failing when pressed.
  useEffect(() => {
    fetch('/api/send')
      .then((r) => r.json())
      .then((d: { configured: boolean; maxBatch?: number }) => {
        setCanSend(Boolean(d.configured));
        if (typeof d.maxBatch === 'number' && d.maxBatch > 0) setMaxBatch(d.maxBatch);
      })
      .catch(() => setCanSend(false));
  }, []);

  const draft = useMemo(
    () => compose(kind, posting, sender, { name: to.name || 'there', email: to.email }, outline),
    [kind, posting, sender, to.name, to.email, outline],
  );

  // An address is the one field with no sensible default: everything else degrades to a
  // bracket, but a draft with no recipient cannot open addressed.
  const ready = to.email.includes('@') && to.name.trim().length > 0;
  const includeCurrent = ready && queue.length < maxBatch;
  /**
   * Queueing clears the form for the next person. That is the whole batch design: N drafts
   * each written for one recipient, not one draft addressed to N people. Nothing here can
   * express a merge-field blast, and `/api/send` posts one envelope per message so nobody
   * learns who else was contacted.
   */
  const queueThis = () => {
    if (!ready || sending) return;
    // Stop AT the cap rather than letting the route reject the batch later. Past the cap the
    // queue could not be sent and could not be shrunk, so the only exit was discarding it.
    if (queue.length >= maxBatch) {
      setResult(`the queue holds ${maxBatch}; send it or drop someone before adding another`);
      return;
    }
    setQueue((q) => [...q, { to: to.email, subject: draft.subject, body: draft.body }]);
    setTo({ name: '', email: '' });
    setOutline({ fit: ['', '', ''] });
    setResult(null);
  };

  /** The way back out of a full queue, and out of a name typed wrong three drafts ago. */
  const unqueue = (index: number) => {
    if (!sending) setQueue((q) => q.filter((_, i) => i !== index));
  };

  const sendQueue = async () => {
    const messages = includeCurrent ? [...queue, { to: to.email, subject: draft.subject, body: draft.body }] : queue;
    if (messages.length === 0 || sending) return;
    const sendToken = sessionToken ?? readSendToken();
    if (!sendToken) {
      setToken('');
      setTokenForm(true);
      return;
    }
    setSending(true);
    setResult(null);
    try {
      const response = await fetch('/api/send', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-workie-send-token': sendToken },
        body: JSON.stringify({ from: sender.from, messages }),
      });
      if (response.status === 401) {
        clearSendToken();
        setSessionToken(null);
        setToken('');
        setTokenForm(true);
        setResult('that send token was not accepted');
      } else if (response.status === 503) {
        setResult('this deployment has no Gmail credentials configured');
      } else if (response.status === 400) {
        // Almost always the sending address: the server holds the list and this bundle does
        // not, so its wording is the only thing that can say which address it rejected.
        const data = (await response.json().catch(() => null)) as { error?: string } | null;
        setResult(data?.error ?? 'that draft was rejected');
      } else if (!response.ok && response.status !== 207) {
        setResult('could not send');
      } else {
        const data = (await response.json()) as { sent: number; failed: { index?: number; to: string; reason: string }[] };
        /**
         * KEEP WHAT FAILED. 207 exists so a partial send can say which recipients missed out;
         * emptying the queue here threw away exactly those drafts — every hand-typed line of
         * them — leaving an address and no way to retry. What sent is dropped, what failed
         * stays queued and can go again once the address is fixed.
         */
        setQueue(stillQueued(messages, data.failed));
        if (includeCurrent) {
          setTo({ name: '', email: '' });
          setOutline({ fit: ['', '', ''] });
        }
        setResult(
          data.failed.length === 0
            ? `sent ${data.sent}`
            : `sent ${data.sent}, still queued ${data.failed.length}: ${data.failed
                .map((f) => `${f.to} (${f.reason})`)
                .join('; ')}`,
        );
      }
    } catch {
      setResult('send status unknown; check your Sent folder before retrying');
    } finally {
      setSending(false);
    }
  };

  const setFit = (index: number, value: string) =>
    setOutline((current) => {
      const fit = [...(current.fit ?? ['', '', ''])];
      fit[index] = value;
      return { ...current, fit };
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 border-t border-rule px-5 py-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">
          {kind === 'coffee' ? 'coffee chat' : 'referral'}
        </span>
        <button type="button" className="chip ml-auto" onClick={onClose} disabled={sending}>
          back
        </button>
        <button
          type="button"
          className="chip"
          aria-disabled={!ready || sending}
          onClick={() => {
            if (!ready || sending) return;
            window.open(composeUrl(to.email, draft.subject, draft.body), '_blank', 'noopener');
          }}
          title={ready ? 'Opens this exact text in Gmail, unsent' : 'Needs a name and an email address'}
        >
          open in gmail
        </button>
        <button
          type="button"
          className="chip"
          aria-disabled={!ready || sending}
          onClick={queueThis}
          title="Adds this draft to the queue and clears the form for the next person"
        >
          queue{queue.length > 0 ? ` (${queue.length})` : ''}
        </button>
        {canSend ? (
          <button
            type="button"
            className="chip"
            aria-disabled={sending || (queue.length === 0 && !ready)}
            onClick={sendQueue}
            title={`Sends each queued draft as its own message, from ${sender.from}`}
          >
            {sending ? 'sending…' : `send ${queue.length + (includeCurrent ? 1 : 0)}`}
          </button>
        ) : null}
      </div>

      {tokenForm ? (
        <form
          aria-label="Send token"
          className="flex flex-wrap items-end gap-2 border-b border-rule pb-3"
          onSubmit={(event) => {
            event.preventDefault();
            const next = token.trim();
            if (!next) return;
            setSessionToken(next);
            const saved = saveSendToken(next);
            setTokenForm(false);
            setResult(saved ? null : 'Browser storage is unavailable; the token will remain until this panel closes.');
          }}
        >
          <fieldset disabled={sending} className="contents border-0 p-0">
            <label className="flex min-w-48 flex-1 flex-col gap-1">
              <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">send token</span>
              <input
                autoFocus
                className="note-input"
                required
                type="password"
                autoComplete="off"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <button type="submit" className="chip">save token</button>
            <button type="button" className="chip" onClick={() => setTokenForm(false)}>cancel</button>
          </fieldset>
        </form>
      ) : null}

      {result ? <p className="text-[11px] text-fg-dim">{result}</p> : null}
      {queue.length > 0 ? (
        <p className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[11px] text-fg-dim">
          <span>
            queued {queue.length}/{maxBatch}:
          </span>
          {queue.map((m, i) => (
            <button
              key={`${m.to}-${i}`}
              type="button"
              className="chip"
              onClick={() => unqueue(i)}
              disabled={sending}
              title={`Remove ${m.to} from the queue`}
            >
              {m.to} ×
            </button>
          ))}
        </p>
      ) : null}

      <fieldset disabled={sending} aria-label="Outreach draft" className="grid min-h-0 min-w-0 flex-1 gap-4 overflow-y-auto border-0 p-0 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <Field label="their name" value={to.name} onChange={(v) => setTo((t) => ({ ...t, name: v }))} />
          <Field
            label="their email"
            value={to.email}
            onChange={(v) => setTo((t) => ({ ...t, email: v }))}
            type="email"
          />

          {kind === 'coffee' ? (
            <Field
              label="what you actually noticed about them"
              hint="If it survives a find-and-replace of the company name, it is not a hook."
              value={outline.hook ?? ''}
              onChange={(v) => setOutline((c) => ({ ...c, hook: v }))}
              rows={3}
            />
          ) : (
            <>
              <Field
                label="where you met"
                value={outline.met ?? ''}
                onChange={(v) => setOutline((c) => ({ ...c, met: v }))}
              />
              <Field
                label="what they said that stuck"
                value={outline.said ?? ''}
                onChange={(v) => setOutline((c) => ({ ...c, said: v }))}
                rows={2}
              />
              <Field
                label="what you did about it"
                value={outline.didWith ?? ''}
                onChange={(v) => setOutline((c) => ({ ...c, didWith: v }))}
                rows={2}
              />
              {/* The referrer is staking their name on being right about you. This is the
                  material they underwrite with, and it is the only part of the referral ask
                  the evidence actually speaks to. */}
              {[0, 1, 2].map((i) => (
                <Field
                  key={i}
                  label={i === 0 ? 'why they would be right about you' : ''}
                  value={outline.fit?.[i] ?? ''}
                  onChange={(v) => setFit(i, v)}
                />
              ))}
            </>
          )}
        </div>

        <div className="min-w-0">
          <p className="mb-1 text-[10px] uppercase tracking-[0.1em] text-fg-dim">
            exactly what gmail receives
          </p>
          <p className="mb-2 text-[11px] text-fg-dim">{draft.subject}</p>
          <pre className="whitespace-pre-wrap break-words text-[12px] leading-[1.5]">{draft.body}</pre>
        </div>
      </fieldset>
    </div>
  );
}

function Field({
  label,
  hint,
  value,
  onChange,
  rows,
  type,
}: {
  label: string;
  hint?: string;
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  type?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      {label ? (
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">{label}</span>
      ) : null}
      {hint ? <span className="text-[11px] text-fg-dim">{hint}</span> : null}
      {rows ? (
        <textarea
          className="note-input"
          rows={rows}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <input
          className="note-input"
          type={type ?? 'text'}
          value={value}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </label>
  );
}
