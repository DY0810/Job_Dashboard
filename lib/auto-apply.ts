/**
 * When a filter change should be applied, as a pure state machine.
 *
 * The rule is not "submit on change", and that is the whole reason this file exists. Two
 * different controls need two different commit points, and both are about not navigating out
 * from under someone mid-selection:
 *
 *   select, pointer     `change` fires once, when the option is chosen. Apply immediately.
 *   select, keyboard    `change` fires on EVERY arrow key in a closed <select> on Windows and
 *                       on Linux Firefox. Applying each one makes the options past the reader's
 *                       current position unreachable — WCAG 3.2.2 (On Input), failure F37. So
 *                       hold it until the control is committed, which is focus leaving it.
 *   checkbox, either    A set filter is chosen by ticking SEVERAL boxes. Applying the first
 *                       tick navigates, re-renders the form, and the second tick becomes a
 *                       second round trip — so a multi-select that applied on change would
 *                       punish the exact use it exists for. Hold until the ticking stops.
 *
 * Nothing on a `change` event says which control produced it or how, so both the input mode and
 * the control kind are carried in. Kept separate from the DOM so it can be tested without a
 * browser: the adapter in `app/auto-apply.tsx` is `addEventListener` calls and one timer.
 */

export type ApplyMode = 'pointer' | 'keyboard';

/** Where a held change is waiting for its commit signal. */
export type Pending =
  /** A keyboard-driven select: committed when focus leaves that specific control. */
  | { commit: 'focusout'; control: string }
  /** A checkbox: committed when the ticking stops, whichever box was last. */
  | { commit: 'idle' };

export interface ApplyState {
  mode: ApplyMode;
  pending: Pending | null;
}

/**
 * Pointer is the starting assumption. A reader who never touches the keyboard gets immediate
 * application from a dropdown, and one who does gets the keyboard rule from their first keystroke.
 */
export const IDLE: ApplyState = { mode: 'pointer', pending: null };

export type ApplyEvent =
  | { kind: 'pointerdown' }
  | { kind: 'keydown'; key: string }
  | { kind: 'change'; control: string; from: 'select' | 'checkbox' }
  | { kind: 'focusout'; control: string }
  /** The adapter's debounce expired: the reader has stopped ticking. */
  | { kind: 'idle' };

export interface ApplyResult {
  state: ApplyState;
  /** True when the form should be submitted now. */
  submit: boolean;
}

/** Keys that commit a selection rather than move through it. */
const COMMIT_KEYS = new Set(['Enter', 'Tab']);

export function applyReducer(state: ApplyState, event: ApplyEvent): ApplyResult {
  switch (event.kind) {
    case 'pointerdown':
      // `pending` survives: clicking away from a control the keyboard was driving still fires
      // focusout for it, and that change deserves to be applied rather than dropped.
      return { state: { ...state, mode: 'pointer' }, submit: false };

    case 'keydown':
      return COMMIT_KEYS.has(event.key)
        ? { state, submit: false }
        : { state: { ...state, mode: 'keyboard' }, submit: false };

    case 'change':
      // A checkbox always waits, whatever drove it — the reader is building a set, and the
      // second tick must not cost a page load. A select applies at once under the pointer.
      if (event.from === 'checkbox') {
        return { state: { ...state, pending: { commit: 'idle' } }, submit: false };
      }
      return state.mode === 'pointer'
        ? { state: { ...state, pending: null }, submit: true }
        : { state: { ...state, pending: { commit: 'focusout', control: event.control } }, submit: false };

    case 'focusout':
      return state.pending?.commit === 'focusout' && state.pending.control === event.control
        ? { state: { ...state, pending: null }, submit: true }
        : { state, submit: false };

    case 'idle':
      return state.pending?.commit === 'idle'
        ? { state: { ...state, pending: null }, submit: true }
        : { state, submit: false };
  }
}
