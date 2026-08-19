# Workie

Local job dashboard. Next.js 15 (App Router) + TypeScript + Tailwind v4 + Drizzle ORM
over SQLite.

## Commands

```bash
npm run dev          # dev server at http://localhost:3000
npm run build        # production build
npm run db:migrate   # apply schema to workie.db (run `db:generate` first after schema changes)
npm test             # run the vitest suite

npm run ingest       # poll every due connector, dedupe, write postings
npm run enrich       # deterministic extraction over the whole corpus (~2s, no network, no cost)
npm run linkcheck    # does every stored apply link still lead to a live posting?
npm run status       # last run per connector, what it brought back, when it goes again
npm run refresh      # one full cycle, exactly as launchd runs it
```

## Unattended refresh

`scripts/refresh.sh` runs ingest, then enrich, plus linkcheck once a week. Install it as a
launchd user agent (from the repo root) to have it run every 30 minutes:

```bash
mkdir -p logs   # launchd opens StandardOutPath before the script runs; it will not create it
sed -e "s|__WORKIE_DIR__|$PWD|g" -e "s|__NODE_BIN__|$(dirname "$(command -v node)")|g" \
  scripts/com.workie.refresh.plist > ~/Library/LaunchAgents/com.workie.refresh.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.workie.refresh.plist
```

Both substitutions matter. launchd hands a job a bare `PATH=/usr/bin:/bin:/usr/sbin:/sbin`,
so an nvm- or homebrew-installed `node` is not found — the usual reason a launchd job appears
to do nothing at all.

```bash
launchctl kickstart -p gui/$(id -u)/com.workie.refresh   # run one cycle now
launchctl print gui/$(id -u)/com.workie.refresh          # state and last exit status
launchctl bootout gui/$(id -u)/com.workie.refresh        # stop and uninstall
```

Logs land in `logs/refresh-YYYY-MM-DD.log`, one file a day, pruned after a fortnight.

### Poll cadence

The 30-minute cycle is a ceiling, not a schedule. Each connector declares a `minIntervalMs`
and is skipped while its last **successful** run is more recent than that, so the sources that
cannot have changed are not asked.

| Source | Interval | Why |
| --- | --- | --- |
| ATS boards — Greenhouse, Lever, Ashby, SmartRecruiters, Workable, Recruitee | every cycle | Where a new posting appears first. This is the point of the tool. |
| `hn` | 6h | "Who is Hiring" is one thread a month. |
| `simplify-internships` | 3h | A hand-maintained GitHub README; a few commits a day. |
| RSS + feed-shaped aggregators — WeWorkRemotely (all + design), Dribbble, Jobspresso, Working Nomads, RemoteOK, Arbeitnow, Braintrust, Himalayas | 1h | Whole board in one response; feeds publish hourly at best. |
| Keyed aggregators — Adzuna, Careerjet, Jooble, USAJobs | 6h | Metered free tiers, measured in calls per month. |

A cadence skip and a missing-key skip are logged apart (`kind: cadence` / `kind: config`) and
neither writes a `connector_runs` row — ghost detection counts a posting absent only against
a run that actually succeeded, so a source that sat out a cycle accrues nothing.

## Design sources

The Design tab is fed differently from Engineering, because design work is published
differently. Three tiers, in descending order of how much they actually contribute:

| Source | What it adds | Note |
| --- | --- | --- |
| `companies.json` design employers | US-based, non-remote, employed design roles | 16 studios and 23 design-led product companies were seeded; 29 confirmed a board. The ATS tier is the only one that reaches an employer's own listing, and the only one carrying office-based US roles. |
| `weworkremotely-design`, `dribbble` | Design-only boards | WWR's design feed states employment type per item in `<type>`, which is where contract design work comes from. Dribbble is design-only but publishes no description — the whole posting is one sentence in the title. |
| `braintrust` | US freelance design | `?role=3` is Braintrust's own Design filter. Every row is freelance with structured US city/state. Small (single digits) but the only verified source of its kind. |

Sources that were evaluated and rejected, so they are not re-litigated: Freelancer.com
ignores its own `category` parameter and publishes company-less gig projects; Authentic Jobs'
feed is now a blog; Coroflot's robots.txt is `Disallow: /`; Core77, Krop, AIGA and Contra
publish no usable feed.

### The Design freelance split

The Design tab is partitioned, not filtered — `employed` and `freelance`, one always on,
`?basis=freelance` in the URL. `freelance` covers `contract` as well, because the extractor
writes `freelance` only when a posting says the word and the same engagement described as "a
6-month contract role" lands as `contract`. An employment type that was never determined
belongs to the employed side; it is not freelance, and a row that matched neither side would
vanish from the tab entirely.

The `type` dropdown narrows to the side being shown, so no reachable URL asks for a full-time
freelance posting. Engineering has no split and no `basis`.

## Deploying

Hosted on the **personal** Vercel account (`dongyeop0810@gmail.com`) reading the Turso mirror.
`scripts/setup-hosting.sh` walks the parts that cannot be automated.

Commits land on `main` by **direct push, not through pull requests**, and that is deliberate.
Vercel only deploys a pushed commit when its author is an identity on the Vercel account, and
GitHub re-authors a squash-merged PR to the public email of the account that opened it — which
put a work address back on `main` even with `user.email` set correctly here. A direct push keeps
the author this repo is configured with:

```bash
git config user.email    # dongyeop0810@gmail.com, set repo-locally
```

A deployment already blocked this way needs no new commit — Redeploy from the dashboard is
authorized by you rather than by the commit author.

## Database

SQLite file at `./workie.db`, created by `npm run db:migrate`. Not committed — see
`.gitignore`. Schema lives in `lib/db/schema.ts`, migrations in `./drizzle`.

## Everything else

See [`plans/workie.md`](plans/workie.md) for architecture, phases, and gates.
