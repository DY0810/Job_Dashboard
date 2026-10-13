'use client';

import { useEffect, useRef, useTransition } from 'react';
import { useRouter } from 'next/navigation';

import { IDLE, applyReducer, type ApplyEvent, type ApplyState } from '@/lib/auto-apply';
import { GROUPS, href, type Group, type Params } from '@/lib/params';

/** The board's results area (`page.tsx`): dimmed while a filter navigation is in flight. */
const RESULTS_ID = 'board-results';

/**
 * A client navigation for a filter change. Only the results change, so the header, the title
 * and the form stay mounted; the results dim (no animation) until the new rows land.
 * `aria-busy` is set from here rather than rendered, so the server's re-render never resets it.
 */
export function useBoardPush() {
  const router = useRouter();
  const [pending, start] = useTransition();
  useEffect(() => {
    const results = document.getElementById(RESULTS_ID);
    if (pending) results?.setAttribute('aria-busy', 'true');
    else results?.removeAttribute('aria-busy');
  }, [pending]);
  return [pending, (url: string) => start(() => router.push(url, { scroll: false }))] as const;
}

/**
 * How long the ticking has to stop before a checkbox set is applied.
 *
 * Long enough to tick a second box without a page load in between — the reason a multi-select
 * cannot apply on change — and short enough that a single tick still feels like a click rather
 * than a wait. Every tick restarts it, so ticking four boxes is one navigation, not four.
 */
const IDLE_MS = 450;

/**
 * Applies the filter form as soon as a control settles, so nobody has to click "filter".
 *
 * Deliberately thin: every decision about WHEN lives in `lib/auto-apply.ts`, which is tested
 * without a browser. This is the wiring only — which DOM events map to which machine events,
 * one debounce timer, and calling `requestSubmit` when the machine says to. Keep it that way;
 * logic added here is logic nothing can test, since the project has no DOM test environment.
 *
 * It finds its own form rather than taking a ref, which lets `Filters` stay a server component.
 * The submit button stays in that form: it is the path without JavaScript, and it is what a
 * keyboard user can still press deliberately.
 */
export function AutoApply({ p }: { p: Params }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const state = useRef<ApplyState>(IDLE);
  const [pending, push] = useBoardPush();
  const pushRef = useRef(push);
  pushRef.current = push;
  const current = href(p);

  /**
   * The controls are uncontrolled and are NOT remounted per URL any more (that was what reset a
   * second tick made while the first one's navigation was in flight). Instead the URL is written
   * into them here once it lands, unless the reader has a change of their own still waiting to
   * be applied: their selection wins until it is submitted, and then the URL agrees with it.
   * Navigations from outside the form (a badge, a tab, back, my filter) land here too.
   */
  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form || pending || state.current.pending) return;
    for (const control of form.elements) {
      if (control instanceof HTMLInputElement && control.type === 'checkbox' && GROUPS.includes(control.name as Group)) {
        control.checked = p[control.name as Group].includes(control.value);
      } else if (control instanceof HTMLSelectElement && control.name === 'posted') {
        control.value = p.posted ?? '';
      }
    }
    // Tell listeners (the filter button) that what the form shows has changed.
    form.dispatchEvent(new Event('change'));
    // `p` is read through `current`, its canonical string.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, pending]);

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return;

    let timer: number | undefined;

    const send = (event: ApplyEvent) => {
      const result = applyReducer(state.current, event);
      state.current = result.state;
      // A held checkbox change needs something to wake it up; nothing else in the DOM will.
      if (state.current.pending?.commit === 'idle') {
        window.clearTimeout(timer);
        timer = window.setTimeout(() => send({ kind: 'idle' }), IDLE_MS);
      }
      // `requestSubmit` fires `submit` and runs validation; `form.submit()` skips both.
      if (result.submit) {
        window.clearTimeout(timer);
        form.requestSubmit();
      }
    };

    /**
     * Controls are identified by `name`, which every filter control has and which is stable
     * across the re-render a navigation causes. A checkbox group shares one name across its
     * boxes — which is correct here: the group is one filter, and its commit is one submit.
     */
    const controlOf = (target: EventTarget | null) => {
      if (target instanceof HTMLSelectElement) return { control: target.name, from: 'select' as const };
      if (target instanceof HTMLInputElement && target.type === 'checkbox') {
        return { control: target.name, from: 'checkbox' as const };
      }
      return null;
    };

    const onPointerDown = () => send({ kind: 'pointerdown' });
    const onKeyDown = (event: KeyboardEvent) => send({ kind: 'keydown', key: event.key });
    const onChange = (event: Event) => {
      const found = controlOf(event.target);
      if (found) send({ kind: 'change', control: found.control, from: found.from });
    };
    const onFocusOut = (event: FocusEvent) => {
      const found = controlOf(event.target);
      if (found) send({ kind: 'focusout', control: found.control });
    };

    /**
     * The native GET would reload the whole document for a change that only touches the table.
     * Same URL the browser would build (every control, `?posted=&level=entry`), pushed through
     * the router instead. Without JavaScript none of this runs and the native submit still works.
     */
    const onSubmit = (event: SubmitEvent) => {
      event.preventDefault();
      const query = new URLSearchParams();
      for (const [name, value] of new FormData(form)) if (typeof value === 'string') query.append(name, value);
      pushRef.current(`${new URL(form.action).pathname}?${query}`);
    };

    // Capture for the input events so they are seen before `change`, whatever is between.
    form.addEventListener('pointerdown', onPointerDown, true);
    form.addEventListener('keydown', onKeyDown, true);
    form.addEventListener('change', onChange);
    form.addEventListener('focusout', onFocusOut);
    form.addEventListener('submit', onSubmit);
    return () => {
      window.clearTimeout(timer);
      form.removeEventListener('pointerdown', onPointerDown, true);
      form.removeEventListener('keydown', onKeyDown, true);
      form.removeEventListener('change', onChange);
      form.removeEventListener('focusout', onFocusOut);
      form.removeEventListener('submit', onSubmit);
    };
  }, []);

  return <span ref={anchor} hidden />;
}
