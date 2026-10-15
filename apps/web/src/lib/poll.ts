// A busy/queued state machine for a poll that must not silently drop a
// forced request that arrived while the previous one was still running.
//
// The bug this guards: App.svelte's refreshStatus() returns immediately
// while a poll is in flight. A plain 10s tick skipping itself is fine, but
// a forced one (a world switch, or an action that bumped statusSeq) must
// not be lost: the Review badge could then show a stale escalation count
// until the 60s plan cache happens to expire on its own.

export interface ForcePollState {
  busy: boolean;
  queuedForce: boolean;
}

export const INITIAL_FORCE_POLL_STATE: ForcePollState = { busy: false, queuedForce: false };

/** Call before starting a poll. An unforced call while busy is simply
 * skipped (the routine tick's own backoff); a forced one is remembered in
 * `queuedForce` instead of being dropped. */
export function requestPoll(state: ForcePollState, force: boolean): { run: boolean; next: ForcePollState } {
  if (state.busy) return { run: false, next: { busy: true, queuedForce: state.queuedForce || force } };
  return { run: true, next: { busy: true, queuedForce: false } };
}

/** Call when a poll finishes. `rerun` is true when a forced request queued
 * while it ran, so the caller should run once more, forced, right away
 * instead of waiting for the next tick or the cache to expire on its own. */
export function finishPoll(state: ForcePollState): { rerun: boolean; next: ForcePollState } {
  return { rerun: state.queuedForce, next: { busy: false, queuedForce: false } };
}
