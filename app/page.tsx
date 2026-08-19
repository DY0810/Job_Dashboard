import { desc } from "drizzle-orm";
import Link from "next/link";
import { redirect } from "next/navigation";
import { TURSO_ENV, driver, getDb, needsTurso } from "@/lib/db";
import { connectorRuns } from "@/lib/db/schema";
import {
  BASES,
  TABS,
  WINDOW_MS,
  bare,
  cleared,
  href,
  parseParams,
  type Params,
  type RawSearchParams,
  type Tab,
  withBasis,
  withJob,
  withTab,
} from "@/lib/params";
import { listPostings, outsideTargetLocations, tabIsEmpty, type Row } from "@/lib/query";
import { Drawer } from "./drawer";
import { BadgeChip, Filters, RowChip } from "./filters";
import { Chevron, ExternalLink } from "./icons";
import { ThemeToggle } from "./theme-toggle";

/**
 * The table, described once: header label and width class together, in render order. `grow`
 * absorbs the slack and `clip` is capped; both truncate rather than wrap, and everything else
 * is sized by its content — so every row stays one line tall whatever the title length. The
 * full title is in the drawer, one click away, which is the right place for it. Engineering
 * caps the title because summary is the column that needs the slack there.
 */
interface Column {
  label: string;
  className?: string;
}

const COLUMNS: Record<Tab, Column[]> = {
  design: [
    { label: "posted" },
    { label: "badges" },
    { label: "title", className: "grow" },
    { label: "pay rate" },
    { label: "company" },
    { label: "apply" },
  ],
  engineering: [
    { label: "posted" },
    { label: "badges" },
    { label: "title", className: "clip" },
    { label: "summary", className: "grow" },
    { label: "pay rate" },
    { label: "level" },
    { label: "grad" },
    { label: "company" },
    { label: "apply" },
  ],
};

/** The width class for one column of the current tab, by the label it renders under. */
function width(tab: Tab, label: string): string | undefined {
  return COLUMNS[tab].find((column) => column.label === label)?.className;
}

/** Relative, because the only question ever asked of this column is "how stale is it". */
function ago(date: Date, now: number): string {
  const minutes = Math.max(0, Math.round((now - date.getTime()) / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

const PERIOD: Record<string, string> = {
  hour: "hr",
  week: "wk",
  month: "mo",
  year: "yr",
};

function payRate(row: Row): string | null {
  const { payRateMin: min, payRateMax: max, payRatePeriod: period } = row;
  if (min === null && max === null) return null;
  const one = (n: number) =>
    period === "year" ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  const span =
    min !== null && max !== null && min !== max
      ? `${one(min)}–${one(max)}`
      : one(min ?? max!);
  return `$${span}/${period ? PERIOD[period] : ""}`;
}

/** A cell with no value still says so. `fg-dim`, not `fg-faint`: it is content, and content
 *  has to clear AA — `fg-faint` is reserved for disabled controls, which WCAG exempts. */
function Nothing() {
  return <span className="text-fg-dim">&mdash;</span>;
}

function Badges({ row, p }: { row: Row; p: Params }) {
  return (
    // Never wraps: a badge cell that stacks would cost four rows of density for one posting.
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      {row.employmentType ? (
        <RowChip p={p} group="type" value={row.employmentType} />
      ) : null}
      {row.workMode ? (
        <RowChip p={p} group="mode" value={row.workMode} />
      ) : null}
      {/* `paid = null` is "the posting does not say" — it claims neither chip. */}
      {row.paid !== null ? (
        <RowChip p={p} group="pay" value={row.paid ? "paid" : "unpaid"} />
      ) : null}
      {row.internshipSeason ? (
        <RowChip p={p} group="season" value={row.internshipSeason} />
      ) : null}
      {/* Engineering carries seniority in its own column; Design has no such column. */}
      {p.tab === "design" && row.seniority ? (
        <RowChip
          p={p}
          group="level"
          value={row.seniority === "entry" ? "junior" : row.seniority}
        />
      ) : null}
      {(row.badges ?? []).map((badge) => (
        <BadgeChip key={badge} p={p} value={badge} />
      ))}
    </span>
  );
}

function PostingRow({ row, p, now }: { row: Row; p: Params; now: number }) {
  const pay = payRate(row);
  const fresh = now - row.postedAt.getTime() < WINDOW_MS.day;
  return (
    <tr>
      <td className={`nums ${fresh ? "text-accent" : "text-fg-dim"}`}>
        <time
          dateTime={row.postedAt.toISOString()}
          title={row.postedAt.toLocaleString()}
        >
          {ago(row.postedAt, now)}
        </time>
      </td>
      <td>
        <Badges row={row} p={p} />
      </td>
      {/* Identifying text, not a facet: no badge, no filter. `title` gives the long tail back
          on hover without costing a row of height. */}
      <td className={width(p.tab, "title")} title={row.title}>
        {row.title}
      </td>
      {p.tab === "engineering" ? (
        <td className={`${width(p.tab, "summary")} text-fg-dim`}>
          {row.summary ?? <Nothing />}
        </td>
      ) : null}
      <td className="nums">{pay ?? <Nothing />}</td>
      {p.tab === "engineering" ? (
        <>
          <td className="text-fg-dim">{row.seniority ?? <Nothing />}</td>
          <td className="nums text-fg-dim">
            {row.expectedGrad ?? <Nothing />}
          </td>
        </>
      ) : null}
      {/* The drawer trigger. One per row, so the tab order through the table stays short. */}
      <td>
        <Link
          href={withJob(p, row.id)}
          scroll={false}
          className="inline-flex items-center gap-1 hover:text-fg-dim"
        >
          {row.company}
          <Chevron />
        </Link>
      </td>
      <td>
        <a
          className="chip"
          href={row.canonicalUrl}
          target="_blank"
          rel="noreferrer noopener"
        >
          apply
          <ExternalLink />
        </a>
      </td>
    </tr>
  );
}

function Band({
  label,
  fresh,
  span,
}: {
  label: string;
  fresh?: boolean;
  span: number;
}) {
  return (
    <tr className={`band${fresh ? " band-fresh" : ""}`}>
      <th colSpan={span} scope="colgroup">
        {label}
      </th>
    </tr>
  );
}

function Command({ children }: { children: string }) {
  return (
    <code className="border border-rule bg-surface px-1 py-px text-fg">
      {children}
    </code>
  );
}

/** Design's location rule is not a filter, so `clear` cannot lift it. An empty table that
 *  blames the ingest when geography is the real cause sends the reader to run a command that
 *  already worked, so the count decides which of the two true explanations to give. */
function Elsewhere({ count }: { count: number }) {
  return (
    <p className="mt-3">
      Design shows the target locations only. {count}{" "}
      {count === 1
        ? "posting is listed outside them and is not"
        : "postings are listed outside them and are not"}{" "}
      on this tab; Engineering shows every location.
    </p>
  );
}

function Empty({ outside }: { outside: number }) {
  return (
    <div className="prose max-w-lg py-12">
      {outside > 0 ? (
        <>
          <p>Nothing on this tab is in the target locations.</p>
          <Elsewhere count={outside} />
        </>
      ) : (
        <>
          <p>
            Nothing in the database for this tab. Run{" "}
            <Command>npm run ingest</Command> to poll the connectors, then{" "}
            <Command>npm run enrich</Command> to classify what came back.
          </p>
          <p className="mt-3">
            For fixtures instead of live postings: <Command>npm run seed</Command>.
          </p>
        </>
      )}
    </div>
  );
}

/** The deployment URL exists before the Turso database does, so the first thing the hosted
 *  site is asked to render is often this. Name the two variables rather than throwing. */
function NotConfigured() {
  return (
    <main className="min-h-dvh px-4 pb-16">
      <header className="flex items-baseline gap-6 border-b border-rule py-2">
        <h1 className="w-wide text-[13px] font-medium">Workie</h1>
        <span className="w-wide text-[11px] text-fg-dim">not configured</span>
      </header>
      <div className="prose max-w-lg py-12">
        <p>No database is configured for this deployment.</p>
        <p className="mt-3">
          Create a Turso database and set{" "}
          {TURSO_ENV.map((name, index) => (
            <span key={name}>
              {index > 0 ? " and " : ""}
              <Command>{name}</Command>
            </span>
          ))}{" "}
          in the project&rsquo;s environment variables, then redeploy. Mirror the local corpus
          into it with <Command>npm run push:remote</Command>.
        </p>
      </div>
    </main>
  );
}

function NoMatches({ p, outside }: { p: Params; outside: number }) {
  return (
    <div className="prose max-w-lg py-12">
      <span className="flex items-baseline gap-3">
        <p>No postings match these filters.</p>
        <Link href={cleared(p)} className="chip" scroll={false}>
          clear
        </Link>
      </span>
      {outside > 0 ? <Elsewhere count={outside} /> : null}
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const raw = await searchParams;
  const p = parseParams(raw);
  // The filter form is a GET form, so it submits every control including the ones set to
  // "any". Land on the URL `href()` would have written, so the address bar, the badge links
  // and a copied URL all agree, and `?type=` never becomes a second spelling of "no filter".
  if (Object.values(raw).some((value) => value === "")) redirect(href(p));

  if (needsTurso()) return <NotConfigured />;

  const now = Date.now();
  const db = getDb();

  const rows = await listPostings(db, p, now);
  const lastRun = await driver(db)
    .select({ startedAt: connectorRuns.startedAt })
    .from(connectorRuns)
    .orderBy(desc(connectorRuns.startedAt))
    .limit(1)
    .get();

  // Recency is the first sort key, so the fresh rows are a prefix, not a partition. Asserted
  // in query.test.ts against this same constant, because nothing in SQL guarantees it now.
  const freshCount = rows.filter(
    (row) => now - row.postedAt.getTime() < WINDOW_MS.day,
  ).length;
  const columns = COLUMNS[p.tab];

  return (
    <main className="min-h-dvh px-4 pb-16">
      <header className="flex items-baseline gap-6 border-b border-rule py-2">
        <h1 className="w-wide text-[13px] font-medium">Workie</h1>
        <nav className="flex gap-4" aria-label="Track">
          {TABS.map((tab) => (
            <Link
              key={tab}
              href={withTab(p, tab)}
              scroll={false}
              aria-current={tab === p.tab ? "page" : undefined}
              className={
                tab === p.tab
                  ? "w-wide border-b border-fg pb-1 text-[11px] text-fg"
                  : "w-wide pb-1 text-[11px] text-fg-dim hover:text-fg"
              }
            >
              {tab}
            </Link>
          ))}
        </nav>
        {/* The Design split. A partition of the tab rather than a filter, so it sits with the
            tabs and not in the filter row: there is no "any", one side is always showing, and
            `clear` does not reset it. Absent on Engineering, where `basis` is null. */}
        {p.basis ? (
          <nav className="flex gap-1.5" aria-label="Engagement">
            {BASES.map((basis) => (
              <Link
                key={basis}
                href={withBasis(p, basis)}
                scroll={false}
                aria-current={basis === p.basis ? "true" : undefined}
                className="chip"
              >
                {basis}
              </Link>
            ))}
          </nav>
        ) : null}

        <div className="ml-auto flex items-baseline gap-4 text-[11px] text-fg-dim">
          <span className="nums">
            {lastRun
              ? `last run ${ago(lastRun.startedAt, now)} ago`
              : "no ingest run yet"}
          </span>
          <ThemeToggle />
        </div>
      </header>

      <Filters p={p} />

      {rows.length === 0 ? (
        // The counts below are the only extra queries, and only on a page with no rows: the
        // empty state asks about the tab, the zero-result state asks about these filters.
        (await tabIsEmpty(db, p, now)) ? (
          <Empty outside={await outsideTargetLocations(db, bare(p), now)} />
        ) : (
          <NoMatches p={p} outside={await outsideTargetLocations(db, p, now)} />
        )
      ) : (
        <table className="rows">
            <caption className="sr-only">
              {p.tab} postings, newest first
              {p.tab === "design" ? ", target locations only" : ""}
              {p.basis ? `, ${p.basis} roles` : ""}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.label} scope="col" className={column.className}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {freshCount > 0 ? (
                <Band label="last 24 hours" fresh span={columns.length} />
              ) : null}
              {rows.slice(0, freshCount).map((row) => (
                <PostingRow key={row.id} row={row} p={p} now={now} />
              ))}
              {freshCount < rows.length ? (
                <Band label="earlier" span={columns.length} />
              ) : null}
              {rows.slice(freshCount).map((row) => (
                <PostingRow key={row.id} row={row} p={p} now={now} />
              ))}
            </tbody>
        </table>
      )}

      <Drawer jobId={p.job} closeHref={withJob(p, null)} />
    </main>
  );
}

export const dynamic = "force-dynamic";
