import { desc } from "drizzle-orm";
import Link from "next/link";
import { getDb } from "@/lib/db";
import { connectorRuns } from "@/lib/db/schema";
import {
  TABS,
  cleared,
  parseParams,
  withJob,
  withTab,
  type Params,
  type RawSearchParams,
  type Tab,
} from "@/lib/params";
import { listPostings, tabIsEmpty, type Row } from "@/lib/query";
import { Drawer } from "./drawer";
import { BadgeChip, Filters, RowChip } from "./filters";
import { Chevron, ExternalLink } from "./icons";
import { ThemeToggle } from "./theme-toggle";

const DAY_MS = 24 * 60 * 60 * 1000;

const COLUMNS: Record<Tab, string[]> = {
  design: ["posted", "badges", "pay rate", "company", "apply"],
  engineering: [
    "posted",
    "badges",
    "summary",
    "pay rate",
    "level",
    "grad",
    "company",
    "apply",
  ],
};

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
  const fresh = now - row.postedAt.getTime() < DAY_MS;
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
      {p.tab === "engineering" ? (
        <td className="grow text-fg-dim">{row.summary ?? <Nothing />}</td>
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
      <td className={p.tab === "design" ? "grow" : undefined}>
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

function Empty() {
  return (
    <div className="prose max-w-lg py-12">
      <p>
        Nothing in the database for this tab. Run{" "}
        <Command>npm run ingest</Command> to poll the connectors, then{" "}
        <Command>npm run enrich</Command> to classify what came back.
      </p>
      <p className="mt-3">
        For fixtures instead of live postings: <Command>npm run seed</Command>.
      </p>
    </div>
  );
}

function NoMatches({ p }: { p: Params }) {
  return (
    <div className="prose flex max-w-lg items-baseline gap-3 py-12">
      <p>No postings match these filters.</p>
      <Link href={cleared(p)} className="chip" scroll={false}>
        clear
      </Link>
    </div>
  );
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  const p = parseParams(await searchParams);
  const now = Date.now();
  const db = getDb();

  const rows = listPostings(db, p, now);
  const lastRun = db
    .select({ startedAt: connectorRuns.startedAt })
    .from(connectorRuns)
    .orderBy(desc(connectorRuns.startedAt))
    .limit(1)
    .get();

  // The sort guarantees the fresh band leads, so the split is a prefix, not a partition.
  const freshCount = rows.filter(
    (row) => now - row.postedAt.getTime() < DAY_MS,
  ).length;
  const columns = COLUMNS[p.tab];

  return (
    <main className="min-h-dvh px-4 pb-16">
      <header className="flex items-baseline gap-6 border-b border-rule py-2">
        <h1 className="w-wide text-[13px] font-medium">Worky</h1>
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
        tabIsEmpty(db, p, now) ? (
          <Empty />
        ) : (
          <NoMatches p={p} />
        )
      ) : (
        <table className="rows">
            <caption className="sr-only">
              {p.tab} postings, newest first
              {p.tab === "design" ? ", target metros above the rest" : ""}
            </caption>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className={
                      (p.tab === "design" && column === "company") ||
                      (p.tab === "engineering" && column === "summary")
                        ? "grow"
                        : undefined
                    }
                  >
                    {column}
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
