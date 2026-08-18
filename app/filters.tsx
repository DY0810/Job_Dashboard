import Link from 'next/link';
import {
  SHARED_VOCAB,
  VOCAB,
  cleared,
  hasFilters,
  toggle,
  withBadge,
  withPosted,
  type Group,
  type Params,
} from '@/lib/params';

const WINDOW_LABEL: Record<string, string> = { hour: '1h', day: '24h', week: '7d', month: '30d' };

/** A filter value, as a link. No client state: the URL is the state. */
export function Chip({
  href,
  on,
  children,
}: {
  href: string;
  on: boolean;
  children: React.ReactNode;
}) {
  return (
    // `aria-current`, not `aria-pressed`: this is a link, and aria-pressed is only
    // supported on role="button" — screen readers ignore it here.
    <Link href={href} className="chip" aria-current={on ? 'true' : undefined} scroll={false}>
      {children}
    </Link>
  );
}

/** Row badges are the same control: clicking one applies exactly that filter. */
export function RowChip({ p, group, value }: { p: Params; group: Group; value: string }) {
  const vocab: readonly string[] = group === 'type' || group === 'season' ? VOCAB[p.tab][group] : SHARED_VOCAB[group];
  // A value with no chip on this tab (a `contract` role on Design, say) still gets shown —
  // it just is not pressable, because there is no filter for it to apply.
  if (!vocab.includes(value)) return <span className="chip">{value}</span>;
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

function Divider() {
  return <span aria-hidden className="mx-1 h-4 border-l border-rule" />;
}

export function Filters({ p }: { p: Params }) {
  const vocab = VOCAB[p.tab];
  const groups: [Group, readonly string[]][] = [
    ['type', vocab.type],
    ['pay', SHARED_VOCAB.pay],
    ['mode', SHARED_VOCAB.mode],
    ['season', vocab.season],
    ['level', SHARED_VOCAB.level],
  ];

  return (
    <div className="flex flex-wrap items-center gap-1 border-b border-rule py-2">
      <span className="mr-1 text-[10px] uppercase tracking-[0.1em] text-fg-dim">posted</span>
      {vocab.posted.map((w) => (
        <Chip key={w} href={withPosted(p, w as Params['posted'])} on={p.posted === w}>
          {WINDOW_LABEL[w]}
        </Chip>
      ))}

      {groups.map(([group, values]) =>
        values.length === 0 ? null : (
          <span key={group} className="flex items-center gap-1">
            <Divider />
            {values.map((value) => (
              <Chip key={value} href={toggle(p, group, value)} on={p[group].includes(value)}>
                {value}
              </Chip>
            ))}
          </span>
        ),
      )}

      {p.badge ? (
        <>
          <Divider />
          <Chip href={withBadge(p, p.badge)} on>
            {p.badge}
          </Chip>
        </>
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
