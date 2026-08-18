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
  # ~40 minutes over the full corpus: the per-host rate limiter serialises the thousands of
  # links that share a greenhouse/ashby host. That overruns the 30-minute interval and costs
  # one ingest cycle a week, which is the right trade against checking only a sample.
  # Stamped BEFORE the run, not after. Sleep, reboot or `launchctl bootout` mid-check would
  # otherwise leave no stamp, so every following cycle restarts the whole thing — each one
  # overrunning the interval and halving ingest's real cadence for as long as it lasts. A
  # missed weekly check is much cheaper than that loop.
  touch "$STAMP"
  say "linkcheck start"
  node scripts/linkcheck.ts   # exit 1 means dead links were FOUND, not that the run failed
  say "linkcheck exit=$?"
fi

say "cycle end"
exit $INGEST
