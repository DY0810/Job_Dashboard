'use client';

import { useId } from 'react';
import { useRouter } from 'next/navigation';

/**
 * A native <select> whose option values are the URLs they lead to. The server computes every
 * href — the same `withGroup` a row badge uses — and this only navigates to the chosen one,
 * so the control and the badges cannot disagree about what a filter means.
 *
 * Native because the keyboard handling, the screen-reader semantics and the mobile picker are
 * several hundred lines nobody has to write, and because the popup is the platform's: it is
 * not part of the app's three-animation budget.
 */
export function SelectNav({
  label,
  on,
  value,
  children,
}: {
  label: string;
  /** A filter is set on this group — the box takes the chip's active treatment. */
  on: boolean;
  /** The href of the currently selected option, which is the current URL. */
  value: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  // `for`/`id` rather than a wrapping <label>: a label that wraps its control folds the
  // selected option into the accessible name ("posted any"), and the name should be "posted".
  const id = useId();
  return (
    <span className="flex items-baseline gap-1.5">
      <label htmlFor={id} className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">
        {label}
      </label>
      <select
        id={id}
        className="select"
        data-on={on ? 'true' : undefined}
        value={value}
        onChange={(event) => router.push(event.target.value, { scroll: false })}
      >
        {children}
      </select>
    </span>
  );
}
