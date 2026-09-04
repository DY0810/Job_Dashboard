'use client';

import { useMemo, useState } from 'react';

import {
  compose,
  composeUrl,
  type Outline,
  type OutreachKind,
  type Posting,
  type Sender,
} from '@/lib/outreach';

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

  const draft = useMemo(
    () => compose(kind, posting, sender, { name: to.name || 'there', email: to.email }, outline),
    [kind, posting, sender, to.name, to.email, outline],
  );

  // An address is the one field with no sensible default: everything else degrades to a
  // bracket, but a draft with no recipient cannot open addressed.
  const ready = to.email.includes('@') && to.name.trim().length > 0;
  const setFit = (index: number, value: string) =>
    setOutline((current) => {
      const fit = [...(current.fit ?? ['', '', ''])];
      fit[index] = value;
      return { ...current, fit };
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 border-t border-rule px-5 py-3">
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">
          {kind === 'coffee' ? 'coffee chat' : 'referral'}
        </span>
        <button type="button" className="chip ml-auto" onClick={onClose}>
          back
        </button>
        <button
          type="button"
          className="chip"
          aria-disabled={!ready}
          onClick={() => {
            if (!ready) return;
            window.open(composeUrl(to.email, draft.subject, draft.body), '_blank', 'noopener');
          }}
          title={ready ? 'Opens this exact text in Gmail' : 'Needs a name and an email address'}
        >
          open in gmail
        </button>
      </div>

      <div className="grid min-h-0 flex-1 gap-4 overflow-y-auto md:grid-cols-2">
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
      </div>
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
