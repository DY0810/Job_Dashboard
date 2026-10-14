/** Controls that act on their own; a click on one never opens the drawer. */
const CONTROL = 'a, button, input, label, select, summary, textarea';

/**
 * The drawer link a click opens: the row's company link (`a[data-job]`), whether the click
 * landed on it or anywhere else in its row. A row's other controls keep their own click.
 */
export function jobLinkFor(target: Element | null): HTMLAnchorElement | null {
  const control = target?.closest?.(CONTROL);
  if (control) return control.closest<HTMLAnchorElement>('a[data-job]');
  return target?.closest?.('tr')?.querySelector<HTMLAnchorElement>('a[data-job]') ?? null;
}
