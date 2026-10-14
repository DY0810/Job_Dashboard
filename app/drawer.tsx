'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseParams } from '@/lib/params';
import type { PostingDetail } from '@/lib/query';
import { type OutreachKind, type Sender } from '@/lib/outreach';
import { OutreachPanel } from './outreach-panel';
import { readSenderDraft, readSenderProfile, saveSenderProfile, validSender } from './outreach-storage';
import { ExternalLink, X } from 'lucide-react';
import { AppliedCheckbox } from './applied-checkbox';
import { jobLinkFor } from './job-link';

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
 *
 * `?job=` moves through native history, which Next syncs into `useSearchParams` without a
 * server round trip: a router navigation re-rendered the whole table on the server
 * to open the drawer, and again to close it.
 */
export function Drawer({ closeHref }: { closeHref: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  const jobId = parseParams({ job: useSearchParams().get('job') ?? undefined }).job;
  const [state, setState] = useState<State>({ status: 'loading' });
  const [drafting, setDrafting] = useState<OutreachKind | null>(null);
  const [sender, setSender] = useState<Sender | null>(null);
  const [senderForm, setSenderForm] = useState<Partial<Sender> | null>(null);
  const [pendingKind, setPendingKind] = useState<OutreachKind | null>(null);
  const [senderError, setSenderError] = useState<string | null>(null);
  const [senderNotice, setSenderNotice] = useState<string | null>(null);
  const [tab, setTab] = useState<'description' | 'email'>('description');

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

  // Rows open the drawer through their plain `<a data-job>` link, one listener for all of them;
  // a click anywhere else in the row opens it too. A modified or middle click falls through to
  // the browser and opens the deep link in a tab, and a drag that selected text opens nothing.
  useEffect(() => {
    const open = (event: MouseEvent) => {
      const link = jobLinkFor(event.target as Element | null);
      if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      if (!window.getSelection()?.isCollapsed && !(event.target as Element).closest('a')) return;
      event.preventDefault();
      // A double click must not push the same entry twice, or Back would reopen a closed drawer.
      if (link.href !== window.location.href) window.history.pushState(null, '', link.href);
    };
    document.addEventListener('click', open);
    return () => document.removeEventListener('click', open);
  }, []);

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
    setTab('description');
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
    if (jobId !== null) window.history.replaceState(null, '', closeHref);
  }, [jobId, closeHref]);

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
        // `detail` < 2: the drawer now opens under the pointer before a double click's second
        // press, which would otherwise land on the backdrop and shut it again.
        if (event.target === ref.current && !drafting && event.detail < 2) close();
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
                {state.posting.remotiveSourceUrl ? (
                  <a
                    href={state.posting.remotiveSourceUrl}
                    className="mt-1 inline-flex items-center gap-1 text-[11px] text-fg-dim underline"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Source: Remotive
                    <ExternalLink size={12} strokeWidth={1.25} absoluteStrokeWidth />
                  </a>
                ) : null}
                <nav className="board-track mt-3" aria-label="Posting views">
                  {(['description', 'email'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="board-track-link cursor-pointer bg-transparent font-[inherit]"
                      aria-current={tab === item ? 'page' : undefined}
                      onClick={() => setTab(item)}
                    >
                      {item === 'description' ? 'Description' : 'Email'}
                    </button>
                  ))}
                </nav>
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
            <X size={12} strokeWidth={1.25} absoluteStrokeWidth />
          </button>
        </div>

        {state.status === 'ready' && tab === 'email' ? (
          // The first panel's own top rule would double the header's.
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto [&>*:first-child]:border-t-0">
            {senderForm ? (
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
            ) : drafting ? (
              <OutreachPanel
                kind={drafting}
                posting={state.posting}
                sender={sender!}
                onClose={() => setDrafting(null)}
              />
            ) : (
              <EmailStart
                company={state.posting.company}
                sender={sender ?? readSenderProfile()}
                onPick={pickKind}
                onEditSender={editSender}
              />
            )}
          </div>
        ) : (
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
              <section aria-label="Application status" className="border-t border-rule pt-4">
                <AppliedCheckbox
                  key={state.posting.id}
                  postingId={state.posting.id}
                  title={state.posting.title}
                  company={state.posting.company}
                />
              </section>
            </div>
          )}
        </div>

        )}

        {senderNotice ? <p className="border-t border-rule px-5 py-2 text-[11px] text-fg-dim">{senderNotice}</p> : null}

        {state.status === 'ready' && tab === 'description' ? (
          <div className="flex items-center gap-2 border-t border-rule px-5 py-3">
            <a
              className="chip"
              href={state.posting.canonicalUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              apply
              <ExternalLink size={12} strokeWidth={1.25} absoluteStrokeWidth />
            </a>
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
 * on every row would add one more tab stop to each of them. More to the
 * point, nobody cold-emails a stranger about a job they have not read: the drawer is where
 * the posting is read, so it is where the draft belongs — one tab over from the description.
 */
/**
 * This stays a form rather than a prompt because the embedded browser does not implement
 * `window.prompt`. It remains per-device browser state: this bundle never knows the configured
 * Gmail addresses and the server still rejects anything it does not hold.
 */
const KINDS: { kind: OutreachKind; label: string; hint: string }[] = [
  { kind: 'coffee', label: 'coffee chat', hint: 'Ask someone on the team for 15 minutes about the work. Not about your application.' },
  { kind: 'referral', label: 'referral', hint: 'Ask someone you have already talked to to refer you for this role.' },
];

/** The Email tab before a draft is picked: the two kinds, and who the email goes out as. */
function EmailStart({ company, sender, onPick, onEditSender }: {
  company: string;
  sender: Sender | null;
  onPick: (kind: OutreachKind) => void;
  onEditSender: () => void;
}) {
  return (
    <div className="prose flex flex-col gap-4 px-5 py-4">
      <p className="text-fg-dim">
        Write to a person at {company} about this posting. Workie fills in the company, role and link; you write
        the personal parts and type their address.
      </p>
      <ul className="flex flex-col gap-3">
        {KINDS.map(({ kind, label, hint }) => (
          <li key={kind} className="flex items-baseline gap-3">
            <button type="button" className="chip shrink-0" onClick={() => onPick(kind)}>
              {label}
            </button>
            <span className="text-[12px] text-fg-dim">{hint}</span>
          </li>
        ))}
      </ul>
      <p className="flex flex-wrap items-baseline gap-2 border-t border-rule pt-4 text-[12px] text-fg-dim">
        {sender ? `Signed and sent as ${sender.name} <${sender.from}>.` : 'No sender saved on this device yet; you set it once.'}
        <button type="button" className="chip" onClick={onEditSender} title="Stored only on this device">
          {sender ? 'edit sender' : 'set sender'}
        </button>
      </p>
    </div>
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
