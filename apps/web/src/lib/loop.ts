// Pure helper for the Loop pane's "run once" poll: deciding whether the
// worker actually produced a new run since the button was pressed.

/** True when `now` is a later instant than `before`. `before` must be
 * captured before the run was triggered: `status.last_run` can already be
 * set from an earlier run, so a plain non-null check stops the poll
 * immediately instead of waiting for the new one to land. */
export function runAdvanced(before: string | null, now: string | null): boolean {
  if (now === null) return false;
  if (before === null) return true;
  const beforeMs = Date.parse(before);
  const nowMs = Date.parse(now);
  if (Number.isNaN(beforeMs) || Number.isNaN(nowMs)) return before !== now;
  return nowMs > beforeMs;
}
