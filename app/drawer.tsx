'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import type { PostingDetail } from '@/lib/query';
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

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (jobId === null) {
      if (dialog.open) dialog.close();
      return;
    }
    if (!dialog.open) dialog.showModal();

    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`/api/postings/${jobId}`, { signal: controller.signal })
      .then(async (response) => {
        if (response.status === 404) throw new Error('That posting is no longer listed.');
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
        if (event.target === ref.current) close();
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

        {state.status === 'ready' ? (
          <div className="border-t border-rule px-5 py-3">
            <a
              className="chip"
              href={state.posting.canonicalUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              apply
              <ExternalLink />
            </a>
          </div>
        ) : null}
      </div>
    </dialog>
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
