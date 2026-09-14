// Pure formatting helpers for worker status timestamps and durations.
// No dependencies so they stay trivial to unit test.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Local date and time, short, plus a relative suffix for anything under a day. */
export function formatTime(iso: string | null): string {
  if (!iso) return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "never";

  const short = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "short" }).format(date);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0 || diffMs >= DAY_MS) return short;

  const minutes = Math.round(diffMs / MINUTE_MS);
  if (minutes < 1) return `${short} (just now)`;
  if (minutes < 60) return `${short} (${minutes} min ago)`;
  const hours = Math.round(diffMs / HOUR_MS);
  return `${short} (${hours} h ago)`;
}

/** "0.2 s" under 10s, "45 s" under a minute, "3 min 12 s" from there up. */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  if (seconds < 60) {
    const value = seconds < 10 ? Math.round(seconds * 10) / 10 : Math.round(seconds);
    return `${value} s`;
  }
  const total = Math.round(seconds);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return `${min} min ${sec} s`;
}
