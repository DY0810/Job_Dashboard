'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PostingDetail } from '@/lib/query';
import { type OutreachKind, type Sender } from '@/lib/outreach';
import { OutreachPanel } from './outreach-panel';
import { readSenderDraft, readSenderProfile, saveSenderProfile, validSender } from './outreach-storage';
import { Close, ExternalLink } from './icons';

type State =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; posting: PostingDetail };

/**
 * The native <dialog>, opened with showModal(). Esc, the top layer, the backdrop, the focus
 * trap and returning focus to the row that opened it are all platform behaviour — there is
 * no library here and no focus-management code, on purpose.
 *
 * The body is fetched rather than shipped with the table: full descriptions across ~2k
 * postings would be megabytes of payload the table cannot use.
 */
export function Drawer({ jobId, closeHref }: { jobId: number | null; closeHref: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const router = useRouter();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [drafting, setDrafting] = useState<OutreachKind | null>(null);
  const [sender, setSender] = useState<Sender | null>(null);
  const [senderForm, setSenderForm] = useState<Partial<Sender> | null>(null);
  const [pendingKind, setPendingKind] = useState<OutreachKind | null>(null);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [senderNotice, setSenderNotice] = useState<string | null>(null);

  /**
   * The sender is asked for once per device and then never again; the RECIPIENT is asked for
   * inside the panel, per posting, because it is a different person at every company.
   */
  const pickKind = (kind: OutreachKind) => {
    const current = readSenderProfile();
    if (!current) {
      setSenderForm(readSenderDraft());
      setPendingKind(kind);
      setSenderError(null);
      return;
    }
    setSender(current);
    setDrafting(kind);
  };

  const editSender = () => {
    setSenderForm(readSenderDraft());
    setPendingKind(null);
    setSenderError(null);
  };

  const saveSender = () => {
    if (!senderForm) return;
    const next = validSender(senderForm);
    if (!next) {
      setSenderError('Complete each field before saving.');
      return;
    }
    const saved = saveSenderProfile(next);
    setSender(next);
    setSenderForm(null);
    setSenderNotice(saved ? null : 'Browser storage is unavailable; this sender is only available in this drawer.');
    if (pendingKind) setDrafting(pendingKind);
    setPendingKind(null);
  };

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (jobId === null) {
      if (dialog.open) dialog.close();
      return;
    }
    // A draft belongs to the posting it was started from; opening another must not inherit it.
    setDrafting(null);
    setSenderForm(null);
    setPendingKind(null);
    if (!dialog.open) dialog.showModal();

    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`/api/postings/${jobId}`, { signal: controller.signal })
      .then(async (response) => {
        // 404 covers delisting, the 60-day cutoff, the seniority ceiling and — on Design —
        // the location rule, and the route deliberately does not say which. Naming only
        // delisting here told people a live posting had been taken down.
        if (response.status === 404) {
          throw new Error('This posting is not shown on this tab any more.');
        }
        if (!response.ok) throw new Error('Could not load this posting.');
        return (await response.json()) as PostingDetail;
      })
      .then((posting) => setState({ status: 'ready', posting }))
      .catch((error: Error) => {
        if (error.name !== 'AbortError') setState({ status: 'error', message: error.message });
      });

    return () => controller.abort();
  }, [jobId]);

  /**
   * Closing has to take the URL with it, or a reload would reopen the drawer. `replace`
   * rather than `push`: closing is an undo, not a new place to go back to.
   *
   * Every route in is covered explicitly rather than by listening for the `close` event —
   * the button and the backdrop call this directly, and Esc arrives as `cancel`, which
   * fires before the platform closes the dialog. Chrome does not reliably deliver `close`
   * to a listener under automation, and this way the behaviour does not depend on it.
   */
  const close = useCallback(() => {
    setSenderForm(null);
    setPendingKind(null);
    setSenderError(null);
    ref.current?.close();
    if (jobId !== null) router.replace(closeHref, { scroll: false });
  }, [jobId, closeHref, router]);

  return (
    <dialog
      ref={ref}
      className="drawer"
      aria-label="Posting detail"
      onCancel={close}
      onClick={(event) => {
        // The dialog element itself is the backdrop area; its child fills the panel.
        //
        // Not while a draft is open. The panel is 544px pinned right, so the backdrop is most
        // of the screen — and a leftward drag-select of the preview text that overshoots
        // releases there, which counts as a backdrop click and used to discard the outline and
        // the whole queue with it. `back` and `close` are both still one press away.
        if (event.target === ref.current && !drafting) close();
      }}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-start gap-4 border-b border-rule px-5 py-3">
          <div className="min-w-0">
            {state.status === 'ready' ? (
              <>
                <h2 className="truncate text-[15px]">{state.posting.title}</h2>
                <p className="mt-1 text-[12px] text-fg-dim">
                  {state.posting.company}
                  {' · '}
                  {/* Location shows on both tabs, even though only Engineering has the column. */}
                  {state.posting.location ?? (state.posting.isRemote ? 'Remote' : 'Location not stated')}
                  {/* Present on 84 of 2,511 engineering rows — far too rare for a column,
                      but the rows that state it are exactly the ones where it decides
                      eligibility. */}
                  {state.posting.expectedGrad ? ` · grad ${state.posting.expectedGrad}` : ''}
                </p>
              </>
            ) : (
              <h2 className="text-[15px] text-fg-dim">
                {state.status === 'loading' ? 'Loading' : 'Unavailable'}
              </h2>
            )}
          </div>
          <button
            type="button"
            className="chip ml-auto"
            onClick={close}
            autoFocus
          >
            close
            <Close />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {state.status === 'loading' ? (
            <p className="prose">Loading the posting.</p>
          ) : state.status === 'error' ? (
            <p className="prose">{state.message}</p>
          ) : (
            <div className="prose flex flex-col gap-5">
              {state.posting.description ? (
                <p className="whitespace-pre-line">{state.posting.description}</p>
              ) : (
                <p>This source did not include a description.</p>
              )}
              <Bullets title="Responsibilities" items={state.posting.responsibilities} />
              <Bullets title="Skills and requirements" items={state.posting.skills} />
              <Bullets title="Education and experience" items={state.posting.education} />
            </div>
          )}
        </div>

        {senderNotice ? <p className="border-t border-rule px-5 py-2 text-[11px] text-fg-dim">{senderNotice}</p> : null}

        {state.status === 'ready' && senderForm ? (
          <SenderProfileForm
            sender={senderForm}
            error={senderError}
            onChange={(field, value) => {
              setSenderForm((current) => ({ ...current, [field]: value }));
              setSenderError(null);
            }}
            onCancel={() => {
              setSenderForm(null);
              setPendingKind(null);
              setSenderError(null);
            }}
            onSave={saveSender}
          />
        ) : state.status === 'ready' && drafting ? (
          <OutreachPanel
            kind={drafting}
            posting={state.posting}
            sender={sender!}
            onClose={() => setDrafting(null)}
          />
        ) : state.status === 'ready' ? (
          <div className="flex items-center gap-2 border-t border-rule px-5 py-3">
            {/* `mr-auto` keeps the terminal action first and visually apart from the drafts. */}
            <a
              className="chip mr-auto"
              href={state.posting.canonicalUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              apply
              <ExternalLink />
            </a>
            <Outreach kind="coffee" onPick={pickKind} />
            <Outreach kind="referral" onPick={pickKind} />
            <button
              type="button"
              className="chip"
              onClick={editSender}
              title="Edit the sender profile stored only on this device"
            >
              sender
            </button>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

/**
 * The outreach drafts live HERE, in the drawer, and not in a table row.
 *
 * The row is the wrong home for them twice over. `.impeccable.md` allows a row exactly three
 * affordances — its badges, the company cell, and Apply — and a fourth control repeated
 * across ~200 rows would add ~200 tab stops to a table that already has 784. More to the
 * point, nobody cold-emails a stranger about a job they have not read: the drawer is where
 * the posting is read, so it is where the draft belongs. Apply sits in this same footer.
 */
/**
 * This stays a form rather than a prompt because the embedded browser does not implement
 * `window.prompt`. It remains per-device browser state: this bundle never knows the configured
 * Gmail addresses and the server still rejects anything it does not hold.
 */
function Outreach({ kind, onPick }: { kind: OutreachKind; onPick: (kind: OutreachKind) => void }) {
  return (
    <button
      type="button"
      className="chip"
      onClick={() => onPick(kind)}
      title="Opens a compose panel: your outline on one side, the finished email on the other."
    >
      {kind === 'coffee' ? 'coffee chat' : 'referral'}
    </button>
  );
}

function SenderProfileForm({
  sender,
  error,
  onChange,
  onCancel,
  onSave,
}: {
  sender: Partial<Sender>;
  error: string | null;
  onChange: (field: keyof Sender, value: string) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  return (
    <form
      aria-label="Sender profile"
      className="flex flex-col gap-3 border-t border-rule px-5 py-3"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <div className="flex items-baseline gap-2">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">sender</span>
        <span className="text-[11px] text-fg-dim">Stored only on this device.</span>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">your name</span>
        <input
          autoFocus
          className="note-input"
          required
          value={sender.name ?? ''}
          onChange={(event) => onChange('name', event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">about you</span>
        <textarea
          className="note-input"
          required
          rows={3}
          value={sender.intro ?? ''}
          onChange={(event) => onChange('intro', event.target.value)}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">Gmail address</span>
        <input
          className="note-input"
          required
          type="email"
          autoComplete="email"
          value={sender.from ?? ''}
          onChange={(event) => onChange('from', event.target.value)}
        />
      </label>
      {error ? <p className="text-[11px] text-fg-dim">{error}</p> : null}
      <div className="flex gap-2">
        <button type="submit" className="chip">save</button>
        <button type="button" className="chip" onClick={onCancel}>cancel</button>
      </div>
    </form>
  );
}

/** Sparse postings are the common case, so a missing list says so rather than vanishing. */
function Bullets({ title, items }: { title: string; items: string[] | null }) {
  return (
    <section>
      <h3 className="mb-1 text-[10px] uppercase tracking-[0.1em] text-fg-dim">{title}</h3>
      {items && items.length > 0 ? (
        <ul className="list-outside list-disc pl-4">
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      ) : (
        <p>Not listed on this posting.</p>
      )}
    </section>
  );
}
