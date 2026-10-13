// Client-safe: the daily auto-apply start, a minute after local midnight in an IANA time zone.
const DAY_MS = 86_400_000;

/** How far `timeZone`'s wall clock is ahead of UTC at instant `ms`. */
function offset(ms: number, timeZone: string) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
  }).formatToParts(ms).map(({ type, value }) => [type, Number(value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(ms / 1000) * 1000;
}

/** Epoch ms of today's start in `timeZone`, "today" being the local date at `nowMs`. */
export function dailyStartInstant(nowMs: number, minute: number, timeZone: string) {
  const local = nowMs + offset(nowMs, timeZone);
  const wall = local - local % DAY_MS + minute * 60_000;
  // Two passes settle the offset across a DST change; a start inside a spring-forward gap lands an hour early.
  return wall - offset(wall - offset(wall, timeZone), timeZone);
}

export const formatDailyStart = (minute: number) =>
  `${Math.floor(minute / 60) % 12 || 12}:${String(minute % 60).padStart(2, '0')} ${minute < 720 ? 'AM' : 'PM'}`;
