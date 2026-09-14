// Pure formatting helpers for worker status timestamps and durations.
// No dependencies so they stay trivial to unit test.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Local date and time, short, plus a relative suffix for anything under a day. */
export function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "invalid date";

  const short = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || diffMs >= DAY_MS) return short;

  if (diffMs < MINUTE_MS) return `${short} (just now)`;
  // Floor, not round: 23.8h must read "23 h ago", not round up to a day it
  // hasn't reached yet.
  const minutes = Math.floor(diffMs / MINUTE_MS);
  if (minutes < 60) return `${short} (${minutes} min ago)`;
  const hours = Math.floor(diffMs / HOUR_MS);
  return `${short} (${hours} h ago)`;
}

/** "0.2 s" under 10s, "45 s" under a minute, "3 min 12 s" from there up. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  if (seconds < 10) return `${Math.round(seconds * 10) / 10} s`;
  // Round before branching on the minute boundary: 59.7 must roll over to
  // "1 min 0 s", not print as "60 s".
  const total = Math.round(seconds);
  if (total < 60) return `${total} s`;
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min} min ${sec} s`;
}
