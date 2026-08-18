import Link from 'next/link';
import {
  GROUPS,
  SHARED_VOCAB,
  VOCAB,
  cleared,
  hasFilters,
  toggle,
  withBadge,
  withGroup,
  withPosted,
  type Group,
  type Params,
} from '@/lib/params';
import { SelectNav } from './select';

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

function vocabFor(p: Params, group: Group): readonly string[] {
  return group === 'type' || group === 'season' ? VOCAB[p.tab][group] : SHARED_VOCAB[group];
}

/**
 * Row badges are the same control as the dropdown above them: clicking one applies exactly that
 * filter, which is also what selects it in the dropdown, because both write the same param.
 */
export function RowChip({ p, group, value }: { p: Params; group: Group; value: string }) {
  // A value with no filter on this tab (a `contract` role on Design, say) still gets shown —
  // it just is not pressable, because there is no filter for it to apply.
  if (!vocabFor(p, group).includes(value)) return <span className="chip">{value}</span>;
  return (
    <Chip href={toggle(p, group, value)} on={p[group].includes(value)}>
      {value}
    </Chip>
  );
}

export function BadgeChip({ p, value }: { p: Params; value: string }) {
  return (
    <Chip href={withBadge(p, value)} on={p.badge === value}>
      {value}
    </Chip>
  );
}

/**
 * One labelled dropdown per filter category. A group holds a list in the URL, but the controls
 * only ever write one value, so `[0]` is the whole selection — a hand-typed `mode=remote,hybrid`
 * still filters on both, and the box shows the first of them.
 */
export function Filters({ p }: { p: Params }) {
  const vocab = VOCAB[p.tab];

  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 border-b border-rule py-2">
      <SelectNav label="posted" on={p.posted !== null} value={withPosted(p, p.posted)}>
        <option value={withPosted(p, null)}>any</option>
        {vocab.posted.map((window) => (
          <option key={window} value={withPosted(p, window as Params['posted'])}>
            {WINDOW_LABEL[window]}
          </option>
        ))}
      </SelectNav>

      {GROUPS.map((group) => {
        const values = vocabFor(p, group);
        // Design has no season vocabulary, so it gets no season dropdown.
        if (values.length === 0) return null;
        return (
          <SelectNav
            key={group}
            label={group}
            on={p[group].length > 0}
            value={withGroup(p, group, p[group][0] ?? null)}
          >
            <option value={withGroup(p, group, null)}>any</option>
            {values.map((value) => (
              <option key={value} value={withGroup(p, group, value)}>
                {value}
              </option>
            ))}
          </SelectNav>
        );
      })}

      {/* Badges are free slugs, not a fixed vocabulary, so the active one stays a chip. */}
      {p.badge ? (
        <Chip href={withBadge(p, p.badge)} on>
          {p.badge}
        </Chip>
      ) : null}

      <span className="ml-auto">
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
    </div>
  );
}
