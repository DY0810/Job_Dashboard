import Form from 'next/form';
import Link from 'next/link';
import {
  FILTERS,
  cleared,
  hasFilters,
  vocab,
  withFilter,
  type Filter,
  type Group,
  type Params,
} from '@/lib/params';
import { Caret } from './icons';

const WINDOW_LABEL: Record<string, string> = { hour: '1h', day: '24h', week: '7d', month: '30d' };

/** A filter value, as a link. No client state: the URL is the state. */
function Chip({ href, on, children }: { href: string; on: boolean; children: React.ReactNode }) {
  return (
    // `aria-current`, not `aria-pressed`: this is a link, and aria-pressed is only
    // supported on role="button" — screen readers ignore it here.
    <Link href={href} className="chip" aria-current={on ? 'true' : undefined} scroll={false}>
      {children}
    </Link>
  );
}

/**
 * Row badges are the same control as the dropdown above them: both write one value into the
 * same param through the same vocabulary, so clicking a badge is what selects it in its
 * dropdown. The toggle is written here rather than inside the setter — a badge toggles,
 * a dropdown does not.
 */
export function RowChip({ p, group, value }: { p: Params; group: Group; value: string }) {
  // A value with no filter on this tab (a `contract` role on Design, say) still gets shown —
  // it just is not pressable, because there is no filter for it to apply.
  if (!vocab(p.tab, group).includes(value)) return <span className="chip">{value}</span>;
  const on = p[group] === value;
  return (
    <Chip href={withFilter(p, group, on ? null : value)} on={on}>
      {value}
    </Chip>
  );
}

export function BadgeChip({ p, value }: { p: Params; value: string }) {
  const on = p.badge === value;
  return (
    <Chip href={withFilter(p, 'badge', on ? null : value)} on={on}>
      {value}
    </Chip>
  );
}

/**
 * One native <select> per filter. Uncontrolled, and keyed on the value the URL holds, so a
 * back navigation or a badge click remounts it with the right option selected — the DOM is
 * never asked to disagree with the URL, and nothing re-asserts a stale value over the user's
 * pick mid-navigation.
 */
function Select({ p, filter, values }: { p: Params; filter: Filter; values: readonly string[] }) {
  const selected = p[filter];
  const id = `filter-${filter}`;
  return (
    <span className="flex items-baseline gap-1.5">
      <label htmlFor={id} className="text-[10px] uppercase tracking-[0.1em] text-fg-dim">
        {filter}
      </label>
      <span className="select-box" data-on={selected ? 'true' : undefined}>
        <select id={id} name={filter} className="select" defaultValue={selected ?? ''}>
          <option value="">any</option>
          {values.map((value) => (
            <option key={value} value={value}>
              {filter === 'posted' ? WINDOW_LABEL[value] : value}
            </option>
          ))}
        </select>
        <Caret />
      </span>
    </span>
  );
}

/**
 * A GET form, not a set of links: the filter row is six dropdowns and one submit, so it works
 * before hydration and without JavaScript, and — the reason it is a form rather than an
 * onChange handler — arrowing through a closed <select> does not navigate on every keypress.
 * That behaviour is WCAG 3.2.2 (On Input) failure F37, and it can make options unreachable by
 * keyboard on the platforms where a closed select fires `change` per arrow key.
 *
 * `next/form` submits client-side when JS is available and degrades to a plain GET form when
 * it is not. Row badges stay single-click links: a filter you can see is still one action.
 */
export function Filters({ p }: { p: Params }) {
  return (
    <Form
      action="/"
      scroll={false}
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule py-2"
    >
      {/* Submitting replaces the whole query string, so state that is not a control here has
          to ride along. `job` deliberately does not: filtering closes the drawer. */}
      <input type="hidden" name="tab" value={p.tab} />
      {p.badge ? <input type="hidden" name="badge" value={p.badge} /> : null}

      {FILTERS.map((filter) => {
        const values = vocab(p.tab, filter);
        // Design has no season vocabulary, so it gets no season dropdown.
        if (values.length === 0) return null;
        return <Select key={`${filter}:${p[filter] ?? ''}`} p={p} filter={filter} values={values} />;
      })}

      {/* Badges are free slugs, not a fixed vocabulary, so the active one stays a chip. */}
      {p.badge ? <BadgeChip p={p} value={p.badge} /> : null}

      <span className="ml-auto flex items-baseline gap-1">
        <button type="submit" className="chip">
          filter
        </button>
        {hasFilters(p) ? (
          <Link href={cleared(p)} className="chip" scroll={false}>
            clear
          </Link>
        ) : (
          // Real disabled state: there is nothing to clear.
          <span className="chip" aria-disabled="true">
            clear
          </span>
        )}
      </span>
    </Form>
  );
}
