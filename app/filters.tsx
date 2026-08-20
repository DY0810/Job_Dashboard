import Link from 'next/link';
import {
  GROUPS,
  cleared,
  hasFilters,
  href,
  vocab,
  toggleFilter,
  withFilter,
  type Filter,
  type Group,
  type Params,
} from '@/lib/params';
import { AutoApply } from './auto-apply';
import { Chevron } from './icons';

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
 * Row badges are the same control as the checkbox above them: both write into the same param
 * through the same vocabulary, so clicking a badge ticks its box. Now that a group holds a set,
 * clicking a second badge in the same group ADDS to the filter rather than replacing it — which
 * is what made the old behaviour feel broken, since clicking `junior` after `entry` used to
 * throw the first one away.
 */
export function RowChip({ p, group, value }: { p: Params; group: Group; value: string }) {
  // A value with no filter on this side still gets shown — it just is not pressable, because
  // there is no filter for it to apply. `p.basis` is passed so a badge offers what the
  // checkbox above it offers: on the employed side of Design, a `contract` badge is text.
  if (!vocab(p.tab, group, p.basis).includes(value)) return <span className="chip">{value}</span>;
  return (
    <Chip href={toggleFilter(p, group, value)} on={p[group].includes(value)}>
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
 * One native <select> per filter, uncontrolled and keyed on the whole URL: the URL wins on
 * every navigation. Picking several values and then submitting works — nothing re-renders in
 * between — but a navigation *during* that (a badge, a row, a tab) resets the boxes to what
 * the table is actually showing. That is the model this app already claims: the control
 * reports the state, and the state is the URL. The alternative, a pending selection that
 * outlives the page it was made on, leaves a dropdown displaying a filter that is not applied.
 */
function Select({ p, filter, values }: { p: Params; filter: 'posted'; values: readonly string[] }) {
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
        <Chevron />
      </span>
    </span>
  );
}

/**
 * A group filter, as real checkboxes.
 *
 * NOT a `<select multiple>`, which is the obvious answer and the wrong one: it needs ctrl-click
 * to select a second value, gives no hint that it can, and collapses to a tiny scrolling box on
 * a phone. Checkboxes say what they are, each is independently focusable, space toggles one, and
 * the whole thing works before hydration — a checked box submits its name, so the browser
 * produces `?level=entry&level=junior` on its own.
 *
 * The native box is visually hidden rather than removed: it still takes focus, still announces
 * itself as a checkbox with its state, and `.chip-check` paints the label from `:has(:checked)`
 * and `:has(:focus-visible)`. Removing it and painting a div would have cost the keyboard and
 * the screen reader.
 */
function CheckGroup({ p, group, values }: { p: Params; group: Group; values: readonly string[] }) {
  const chosen = p[group];
  return (
    <fieldset className="flex items-baseline gap-1.5 border-0 p-0">
      {/* A legend rather than a label: this names a set of controls, not one of them. */}
      <legend className="float-left text-[10px] uppercase tracking-[0.1em] text-fg-dim">
        {group}
      </legend>
      {values.map((value) => (
        <label key={value} className="chip-check" data-on={chosen.includes(value) ? 'true' : undefined}>
          <input
            type="checkbox"
            name={group}
            value={value}
            defaultChecked={chosen.includes(value)}
            className="chip-check-input"
          />
          {value}
        </label>
      ))}
    </fieldset>
  );
}

/**
 * A GET form, not a set of links: the filter row is six dropdowns and one submit, so it works
 * before hydration and without JavaScript, and — the reason it is a form rather than an
 * onChange handler — arrowing through a closed <select> does not navigate on every keypress.
 * That behaviour is WCAG 3.2.2 (On Input) failure F37, and it can make options unreachable by
 * keyboard on the platforms where a closed select fires `change` per arrow key.
 *
 * A PLAIN `<form>`, not `next/form`, and that is the fix for a broken filter button rather
 * than a preference. `next/form` submits through a client-side navigation: the submit event
 * fired, it issued the RSC request for the right URL, the server answered 200 — and the router
 * never committed, so the button did nothing at all. Verified in a browser against a trusted
 * click, while `Link` navigation on the same page committed normally, so the router was fine
 * and the form wrapper was not.
 *
 * A native GET submit is the behaviour `next/form` was wrapping anyway: it navigates to
 * `/?tab=…&posted=…`, which the page renders directly. The cost is a full page load instead of
 * a client-side one, which for a control that replaces the entire table is not a real loss.
 * Row badges stay single-click links: a filter you can see is still one action.
 */
export function Filters({ p }: { p: Params }) {
  return (
    <form
      action="/"
      className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule py-2"
    >
      {/* Submitting replaces the whole query string, so state that is not a control here has
          to ride along. `job` deliberately does not: filtering closes the drawer. */}
      {/* Applies a dropdown change without waiting for the button. The button stays: it is the
          no-JavaScript path, and it is what a keyboard user can still hit deliberately. */}
      <AutoApply />

      <input type="hidden" name="tab" value={p.tab} />
      {/* The split is a control of its own, above this form. Without it here, submitting the
          filters would drop the reader back onto the employed side. */}
      {p.basis ? <input type="hidden" name="basis" value={p.basis} /> : null}
      {p.badge ? <input type="hidden" name="badge" value={p.badge} /> : null}

      {/* `posted` is the one single-valued filter, so it stays a dropdown. Its windows nest —
          24h is inside 7d — so offering a multi-select there would offer a choice with no
          distinct outcome. */}
      <Select key={`posted:${href(p)}`} p={p} filter="posted" values={vocab(p.tab, 'posted', p.basis)} />

      {GROUPS.map((group) => {
        const values = vocab(p.tab, group, p.basis);
        // Design has no season vocabulary, so it gets no season control at all.
        if (values.length === 0) return null;
        return <CheckGroup key={`${group}:${href(p)}`} p={p} group={group} values={values} />;
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
    </form>
  );
}
