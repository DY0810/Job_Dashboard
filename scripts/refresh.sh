#!/bin/bash
#
# One unattended refresh cycle: ingest, then enrich, plus linkcheck once a week.
# `scripts/com.workie.refresh.plist` runs this every 30 minutes; see the README for install.
#
# Everything here is deliberately serial. Two SQLite writers on one file means SQLITE_BUSY the
# moment a transaction runs longer than the driver's timeout, and ingest's persist over ~5,000
# postings does. launchd will not start a second copy of a job that is still running, so this
# one script running end to end is the whole concurrency policy.
#
#   scripts/refresh.sh              a cycle, as launchd runs it
#   scripts/refresh.sh --linkcheck  force the weekly link check to run now
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

# launchd starts this with a bare environment, so nothing has read `.env.local` — without
# this every keyed connector is permanently "skipped: KEY not set" under the scheduler while
# working fine when you run it from a shell.
set -a
# shellcheck disable=SC1091
[ -f "$ROOT/.env.local" ] && . "$ROOT/.env.local"
set +a

LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

# Rotation, the boring way: one file per day, keep a fortnight. No logrotate, no newsyslog
# config in /etc, and nothing to go stale — a file that stops being written just ages out.
find "$LOG_DIR" -name 'refresh-*.log' -type f -mtime +14 -delete 2>/dev/null
exec >>"$LOG_DIR/refresh-$(date +%Y-%m-%d).log" 2>&1

say() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }

# One cycle at a time. launchd never overlaps itself, but the dashboard's refresh button can
# now start a cycle by hand, and two ingests interleaving is at best wasted requests. A
# mkdir is atomic; the pid inside lets a crashed cycle's lock be reclaimed rather than
# wedging every cycle after it. 75 is EX_TEMPFAIL: "try again later", not "broken".
LOCK="$LOG_DIR/.refresh.lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  other=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$other" ] && kill -0 "$other" 2>/dev/null; then
    say "another cycle is running (pid $other); not starting a second"
    exit 75
  fi
  say "stale lock left by pid ${other:-?}; taking over"
  rm -rf "$LOCK" && mkdir "$LOCK" || exit 75
fi
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK"' EXIT

say "cycle start"
node scripts/ingest.ts
INGEST=$?
say "ingest exit=$INGEST"

# Enrichment is deterministic, free, and takes ~2s for the whole corpus, so it runs every
# cycle regardless of what ingest managed — a rule change in lib/extract.ts reaches the rows
# it was written for on the next cycle rather than whenever someone remembers.
node scripts/enrich.ts
say "enrich exit=$?"

# Weekly, by stamp file rather than by a second calendar job: a laptop that was asleep at
# 04:00 on Sunday still gets its link check on the next cycle after it wakes.
STAMP="$LOG_DIR/.linkcheck-stamp"
if [ "${1:-}" = "--linkcheck" ] || [ -z "$(find "$STAMP" -mtime -7 2>/dev/null)" ]; then
  # Stamped BEFORE the run, not after. Sleep, reboot or `launchctl bootout` mid-check would
  # otherwise leave no stamp, so every following cycle restarts the whole thing — each one
  # overrunning the interval and halving ingest's real cadence for as long as it lasts. A
  # missed weekly check is much cheaper than that loop.
  touch "$STAMP"
  say "linkcheck start"

  # HARD TIME BUDGET, and it is not paranoia. `linkcheck` honours each host's robots.txt
  # `Crawl-delay`, and news.ycombinator.com publishes 30 SECONDS — 153 postings point there,
  # so that one host alone serialises into ~76 minutes, and a host publishing an hour would
  # be worse without limit. launchd will not start a second copy of this job, so an unbounded
  # link check does not just delay ingest: it stops the dashboard updating for as long as it
  # runs. Better a link check that gives up and retries next week.
  #
  # `perl -e alarm` because macOS ships no timeout(1) and perl is always there.
  perl -e 'alarm shift; exec @ARGV' 5400 node scripts/linkcheck.ts
  say "linkcheck exit=$? (budget 90m; 142 = killed at the budget, 1 = dead links found)"
fi

# Mirror the corpus up to the hosted read replica, when one is configured. A missing
# TURSO_DATABASE_URL is a skip, not an error — same rule the keyed connectors follow, and it
# keeps this cycle working unchanged on a machine that never deploys.
if [ -f .env.local ] && grep -qE '^TURSO_DATABASE_URL=.+' .env.local; then
  # --in-cycle: THIS is the cycle that holds the lock, so the mirror must not refuse it.
  # Without the flag push-remote sees a live pid in the lock and skips, which silently
  # stopped every cycle from reaching the hosted site while still exiting 0.
  node --env-file-if-exists=.env.local scripts/push-remote.ts --in-cycle
  say "push:remote exit=$?"
else
  say "push:remote skipped (no TURSO_DATABASE_URL in .env.local)"
fi

say "cycle end"
exit $INGEST
