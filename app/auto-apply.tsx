'use client';

import { useEffect, useRef } from 'react';

import { IDLE, applyReducer, type ApplyEvent, type ApplyState } from '@/lib/auto-apply';

/**
 * Applies the filter form as soon as a dropdown changes, so nobody has to click "filter".
 *
 * Deliberately thin: every decision lives in `lib/auto-apply.ts`, which is tested without a
 * browser. This is only the wiring — which DOM events map to which machine events, and calling
 * `requestSubmit` when the machine says to. Keep it that way; logic added here is logic that
 * cannot be tested, since the project has no DOM test environment.
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

    const send = (event: ApplyEvent) => {
      const result = applyReducer(state, event);
      state = result.state;
      // `requestSubmit` fires `submit` and runs validation; `form.submit()` skips both.
      if (result.submit) form.requestSubmit();
    };

    // A control is identified by `name`, which every filter select has and which is stable
    // across the re-render a navigation causes.
    const nameOf = (target: EventTarget | null) =>
      target instanceof HTMLSelectElement ? target.name : null;

    const onPointerDown = () => send({ kind: 'pointerdown' });
    const onKeyDown = (event: KeyboardEvent) => send({ kind: 'keydown', key: event.key });
    const onChange = (event: Event) => {
      const control = nameOf(event.target);
      if (control) send({ kind: 'change', control });
    };
    const onFocusOut = (event: FocusEvent) => {
      const control = nameOf(event.target);
      if (control) send({ kind: 'focusout', control });
    };

    // Capture for the input events so they are seen before `change`, whatever is between.
    form.addEventListener('pointerdown', onPointerDown, true);
    form.addEventListener('keydown', onKeyDown, true);
    form.addEventListener('change', onChange);
    form.addEventListener('focusout', onFocusOut);
    return () => {
      form.removeEventListener('pointerdown', onPointerDown, true);
      form.removeEventListener('keydown', onKeyDown, true);
      form.removeEventListener('change', onChange);
      form.removeEventListener('focusout', onFocusOut);
    };
  }, []);

  return <span ref={anchor} hidden />;
}
