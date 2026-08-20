'use client';

import { useEffect, useRef } from 'react';

import { IDLE, applyReducer, type ApplyEvent, type ApplyState } from '@/lib/auto-apply';

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
export function AutoApply() {
  const anchor = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const form = anchor.current?.closest('form');
    if (!form) return;

    let state: ApplyState = IDLE;
    let timer: number | undefined;

    const send = (event: ApplyEvent) => {
      const result = applyReducer(state, event);
      state = result.state;
      // A held checkbox change needs something to wake it up; nothing else in the DOM will.
      if (state.pending?.commit === 'idle') {
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

    // Capture for the input events so they are seen before `change`, whatever is between.
    form.addEventListener('pointerdown', onPointerDown, true);
    form.addEventListener('keydown', onKeyDown, true);
    form.addEventListener('change', onChange);
    form.addEventListener('focusout', onFocusOut);
    return () => {
      window.clearTimeout(timer);
      form.removeEventListener('pointerdown', onPointerDown, true);
      form.removeEventListener('keydown', onKeyDown, true);
      form.removeEventListener('change', onChange);
      form.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  return <span ref={anchor} hidden />;
}
