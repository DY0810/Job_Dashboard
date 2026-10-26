'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { parseParams } from '@/lib/params';
import type { PostingDetail } from '@/lib/query';
import { linkedinSearches, type Recruiters } from '@/lib/recruiters';
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
  const [tab, setTab] = useState<'description' | 'recruiters'>('description');

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
        // `detail` < 2: the drawer now opens under the pointer before a double click's second
        // press, which would otherwise land on the backdrop and shut it again.
        if (event.target === ref.current && event.detail < 2) close();
      }}
    >
      <div className="flex h-full flex-col">
        <div className="dialog-head">
          <div className="min-w-0">
            {state.status === 'ready' ? (
              <>
                <h2 className="truncate">{state.posting.title}</h2>
                <p className="mt-1 text-[13px] text-fg-dim">
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
                    className="link mt-1 inline-flex items-center gap-1 text-[12px]"
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    Source: Remotive
                    <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                  </a>
                ) : null}
                <nav className="board-track mt-3 -ml-2.5" aria-label="Posting views">
                  {(['description', 'recruiters'] as const).map((item) => (
                    <button
                      key={item}
                      type="button"
                      className="board-track-link"
                      aria-current={tab === item ? 'page' : undefined}
                      onClick={() => setTab(item)}
                    >
                      {item === 'description' ? 'Description' : 'Recruiters'}
                    </button>
                  ))}
                </nav>
              </>
            ) : (
              <h2 className="text-fg-dim">
                {state.status === 'loading' ? 'Loading' : 'Unavailable'}
              </h2>
            )}
          </div>
          <button
            type="button"
            className="btn ghost icon ml-auto -mr-2 -mt-1"
            onClick={close}
            autoFocus
            aria-label="Close"
            title="Close"
          >
            <X size={18} strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>

        {state.status === 'ready' && tab === 'recruiters' ? (
          <RecruitersPanel key={state.posting.id} posting={state.posting} />
        ) : (
        <div className="dialog-body">
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
              <section aria-label="Application status" className="border-t border-rule pt-4 text-[13px]">
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

        {state.status === 'ready' && tab === 'description' ? (
          <div className="dialog-foot">
            <a
              className="btn primary"
              href={state.posting.canonicalUrl}
              target="_blank"
              rel="noreferrer noopener"
            >
              Apply
              <ExternalLink size={16} strokeWidth={1.75} aria-hidden="true" />
            </a>
          </div>
        ) : null}
      </div>
    </dialog>
  );
}

type Lookup =
  | { status: 'loading' }
  | { status: 'signed_out' }
  | { status: 'error' }
  | { status: 'ready'; recruiters: Recruiters };

const LOOKUP_NOTE: Record<Recruiters['lookup'], string> = {
  ok: '',
  no_key: 'Recruiter lookup is not set up (no Hunter key), so only LinkedIn searches are shown.',
  unavailable: 'Could not reach Hunter right now; it may be over its monthly quota.',
};

/**
 * Answers already fetched this page load, by company: the lookup is per company, so switching
 * tabs or opening another role there never asks again. Failures are not kept, so they retry.
 */
const looked = new Map<string, Recruiters>();

/**
 * Who to reach at this employer: Hunter's HR and recruiting people, recruiters first, each
 * with their LinkedIn below them. Fetched only when this tab opens, because each lookup
 * spends Hunter quota. The LinkedIn searches need no lookup and always show.
 */
function RecruitersPanel({ posting }: { posting: PostingDetail }) {
  const [lookup, setLookup] = useState<Lookup>(() => {
    const known = looked.get(posting.company);
    return known ? { status: 'ready', recruiters: known } : { status: 'loading' };
  });
  useEffect(() => {
    if (looked.has(posting.company)) return;
    const controller = new AbortController();
    fetch(`/api/postings/${posting.id}/recruiters`, { credentials: 'same-origin', signal: controller.signal })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) return setLookup({ status: 'signed_out' });
        if (!response.ok) return setLookup({ status: 'error' });
        const recruiters = (await response.json()) as Recruiters;
        if (recruiters.lookup === 'ok') looked.set(posting.company, recruiters);
        setLookup({ status: 'ready', recruiters });
      })
      .catch((error: Error) => { if (error.name !== 'AbortError') setLookup({ status: 'error' }); });
    return () => controller.abort();
  }, [posting.id, posting.company]);

  const searches = lookup.status === 'ready' ? lookup.recruiters.searches : linkedinSearches(posting.company);
  const found = lookup.status === 'ready' ? lookup.recruiters : null;
  return (
    <div className="dialog-body prose flex flex-col gap-5">
      {lookup.status === 'loading' ? <p className="text-fg-dim">Looking up recruiters at {posting.company}.</p> : null}
      {lookup.status === 'signed_out' ? (
        <p className="text-fg-dim">
          <a href="/sign-in" className="link">Sign in</a> to look up recruiters by name. The LinkedIn searches below work either way.
        </p>
      ) : null}
      {lookup.status === 'error' ? <p className="text-fg-dim">Could not load recruiters for this posting.</p> : null}
      {found && found.lookup !== 'ok' ? <p className="text-fg-dim">{LOOKUP_NOTE[found.lookup]}</p> : null}
      {found && found.lookup === 'ok' ? (
        found.people.length === 0 ? (
          <p className="text-fg-dim">Hunter found no HR or recruiting people for {found.domain ?? posting.company}.</p>
        ) : (
          <section aria-label="Recruiters" className="flex flex-col gap-3">
            <p className="text-[12px] text-fg-dim">
              From Hunter.io for {found.domain ?? posting.company}. Check that domain is this company before reaching out.
            </p>
            <ul className="flex flex-col gap-3">
              {found.people.map((person, index) => (
                <li key={person.email ?? index} className="flex flex-col gap-0.5 border-t border-rule pt-3 first:border-t-0 first:pt-0">
                  <span className="text-[14px] font-semibold text-fg">{person.name ?? 'Name not listed'}</span>
                  <span className="text-[13px] text-fg-dim">{person.title ?? 'Title not listed'}</span>
                  <span className="flex flex-wrap gap-x-3 text-[13px]">
                    {person.linkedin ? (
                      <a href={person.linkedin} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1">
                        LinkedIn
                        <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                      </a>
                    ) : person.name ? (
                      <a
                        href={`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${person.name} ${posting.company}`)}`}
                        target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1"
                      >
                        Find on LinkedIn
                        <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
                      </a>
                    ) : null}
                    {person.email ? <a href={`mailto:${person.email}`} className="link">{person.email}</a> : null}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )
      ) : null}
      <section aria-label="LinkedIn searches" className="flex flex-col gap-2 border-t border-rule pt-4">
        <span className="label">Search LinkedIn</span>
        {searches.map((search) => (
          <a key={search.url} href={search.url} target="_blank" rel="noreferrer noopener" className="link inline-flex items-center gap-1 self-start text-[13px]">
            {search.label}
            <ExternalLink size={12} strokeWidth={1.75} aria-hidden="true" />
          </a>
        ))}
      </section>
    </div>
  );
}

/** Sparse postings are the common case, so a missing list says so rather than vanishing. */
function Bullets({ title, items }: { title: string; items: string[] | null }) {
  return (
    <section>
      <h3 className="label mb-1.5">{title}</h3>
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
