/**
 * When a filter change should be applied, as a pure state machine.
 *
 * The rule is not "submit on change", and that is the whole reason this file exists. A closed
 * `<select>` fires `change` on every arrow key on Windows and on Linux Firefox. Submitting on
 * each one navigates the page out from under a keyboard user mid-selection, so the options past
 * their current position become unreachable — WCAG 3.2.2 (On Input), failure F37.
 *
 * So the trigger depends on how the control is being driven:
 *
 *   pointer    `change` fires once, when the option is chosen. Apply it immediately.
 *   keyboard   `change` fires per arrow key. Hold it until the control is committed, which is
 *              focus leaving it. Enter submits natively, as in any form.
 *
 * Nothing on a `change` event distinguishes the two, so the mode is carried from the last input
 * event seen. Kept separate from the DOM so it can be tested without a browser: the adapter in
 * `app/auto-apply.tsx` is only `addEventListener` calls feeding this.
 */

export type ApplyMode = 'pointer' | 'keyboard';

export interface ApplyState {
  mode: ApplyMode;
  /** The control whose keyboard change is waiting to be committed, if any. */
  pending: string | null;
}

/**
 * Pointer is the starting assumption. A reader who never touches the keyboard then gets
 * immediate application, and one who does gets the keyboard rule from their first keystroke.
 */
export const IDLE: ApplyState = { mode: 'pointer', pending: null };

export type ApplyEvent =
  | { kind: 'pointerdown' }
  | { kind: 'keydown'; key: string }
  | { kind: 'change'; control: string }
  | { kind: 'focusout'; control: string };

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
      // `pending` survives: clicking away from a select the keyboard was driving still fires
      // focusout for it, and that change deserves to be applied rather than dropped.
      return { state: { ...state, mode: 'pointer' }, submit: false };

    case 'keydown':
      return COMMIT_KEYS.has(event.key)
        ? { state, submit: false }
        : { state: { ...state, mode: 'keyboard' }, submit: false };

    case 'change':
      return state.mode === 'pointer'
        ? { state: { ...state, pending: null }, submit: true }
        : { state: { ...state, pending: event.control }, submit: false };

    case 'focusout':
      return state.pending === event.control
        ? { state: { ...state, pending: null }, submit: true }
        : { state, submit: false };
  }
}
