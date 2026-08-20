/**
 * The filter form applies itself on change. This pins the half that can be wrong: WHEN.
 *
 * The failure this guards against is not cosmetic. Submitting on every `change` would navigate
 * on every arrow key in a closed `<select>` on Windows and Linux Firefox, which makes the
 * options past the reader's current position unreachable by keyboard — WCAG 3.2.2, failure F37.
 */

import { describe, expect, it } from 'vitest';

import { IDLE, applyReducer, type ApplyEvent, type ApplyState } from './auto-apply.ts';

/** Feeds a sequence and returns how many submits it asked for, plus the final state. */
function run(events: ApplyEvent[], from: ApplyState = IDLE) {
  let state = from;
  let submits = 0;
  for (const event of events) {
    const result = applyReducer(state, event);
    state = result.state;
    if (result.submit) submits += 1;
  }
  return { submits, state };
}

const arrow = { kind: 'keydown', key: 'ArrowDown' } as const;
const change = (control = 'level') => ({ kind: 'change', control, from: 'select' }) as const;
const tick = (control = 'level') => ({ kind: 'change', control, from: 'checkbox' }) as const;
const idle = { kind: 'idle' } as const;
const focusout = (control = 'level') => ({ kind: 'focusout', control }) as const;

describe('applyReducer', () => {
  it('applies a pointer change immediately', () => {
    expect(run([{ kind: 'pointerdown' }, change()]).submits).toBe(1);
  });

  /** The F37 case, and the reason this is not a one-line change handler. */
  it('does not apply anything while the keyboard is moving through the options', () => {
    const { submits } = run([arrow, change(), arrow, change(), arrow, change()]);
    expect(submits, 'a submit here navigates the page out from under the reader').toBe(0);
  });

  it('applies once the keyboard-driven control is committed', () => {
    const { submits } = run([arrow, change(), arrow, change(), focusout()]);
    expect(submits).toBe(1);
  });

  it('applies a keyboard change only once, however many options were passed', () => {
    const { submits } = run([arrow, change(), arrow, change(), arrow, change(), focusout()]);
    expect(submits).toBe(1);
  });

  it('ignores focusout from a control that never changed', () => {
    expect(run([arrow, change('level'), focusout('mode')]).submits).toBe(0);
  });

  it('does not re-apply on a second focusout', () => {
    expect(run([arrow, change(), focusout(), focusout()]).submits).toBe(1);
  });

  /** Tabbing between two selects applies the first as focus leaves it. */
  it('applies each control as the keyboard leaves it', () => {
    const { submits } = run([
      arrow, change('posted'), focusout('posted'),
      arrow, change('level'), focusout('level'),
    ]);
    expect(submits).toBe(2);
  });

  it('treats Enter and Tab as commits, not as movement', () => {
    // Enter submits natively; it must not flip the mode and strand a pending change.
    expect(run([{ kind: 'pointerdown' }, { kind: 'keydown', key: 'Enter' }, change()]).submits).toBe(1);
    expect(run([{ kind: 'pointerdown' }, { kind: 'keydown', key: 'Tab' }, change()]).submits).toBe(1);
  });

  it('switches back to immediate once the pointer takes over', () => {
    const { submits } = run([arrow, change('mode'), { kind: 'pointerdown' }, change('level')]);
    expect(submits, 'the pointer change applies; the stale keyboard one waits for its focusout').toBe(1);
  });

  it('still applies a keyboard change abandoned by a click elsewhere', () => {
    // pointerdown must not discard `pending`, or the change is silently lost.
    const { submits } = run([arrow, change('level'), { kind: 'pointerdown' }, focusout('level')]);
    expect(submits).toBe(1);
  });

  it('starts out assuming a pointer', () => {
    expect(IDLE).toEqual({ mode: 'pointer', pending: null });
  });
});

/**
 * Checkboxes, which is where a set filter is actually built. The failure this guards against is
 * not accessibility but plain uselessness: applying on the first tick navigates, re-renders the
 * form, and turns "entry and junior" into two page loads — punishing the exact use multi-select
 * exists for.
 */
describe('applyReducer — checkbox sets', () => {
  const tickBox = (control = 'level') => ({ kind: 'change', control, from: 'checkbox' }) as const;
  const idleEvent = { kind: 'idle' } as const;

  it('does not apply while boxes are still being ticked', () => {
    expect(run([tickBox(), tickBox(), tickBox()]).submits).toBe(0);
  });

  it('applies once when the ticking stops, however many boxes were ticked', () => {
    expect(run([tickBox(), tickBox(), tickBox(), idleEvent]).submits).toBe(1);
  });

  it('waits even under the pointer, unlike a dropdown', () => {
    // The pointer shortcut is a select-only rule: a mouse user ticking two boxes needs the
    // same grace a keyboard user needs.
    expect(run([{ kind: 'pointerdown' }, tickBox()]).submits).toBe(0);
    expect(run([{ kind: 'pointerdown' }, tickBox(), idleEvent]).submits).toBe(1);
  });

  it('applies boxes ticked across different groups in one submit', () => {
    expect(run([tickBox('level'), tickBox('mode'), tickBox('type'), idleEvent]).submits).toBe(1);
  });

  it('does not re-apply on a second idle', () => {
    expect(run([tickBox(), idleEvent, idleEvent]).submits).toBe(1);
  });

  it('ignores an idle with nothing held', () => {
    expect(run([idleEvent]).submits).toBe(0);
  });

  /** A tick then Tab away: focusout must not steal a commit that belongs to the idle timer. */
  it('is committed by idle, not by focusout', () => {
    expect(run([tickBox('level'), { kind: 'focusout', control: 'level' }]).submits).toBe(0);
    expect(run([tickBox('level'), { kind: 'focusout', control: 'level' }, idleEvent]).submits).toBe(1);
  });

  /** A dropdown change after ticking replaces the held checkbox commit with its own rule. */
  it('lets an immediate select change apply without waiting for the idle', () => {
    const { submits, state } = run([tickBox('level'), { kind: 'pointerdown' }, { kind: 'change', control: 'posted', from: 'select' }]);
    expect(submits).toBe(1);
    expect(state.pending, 'the select submit clears the held tick').toBeNull();
  });
});
