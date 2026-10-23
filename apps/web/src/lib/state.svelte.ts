// Shared, mutable app state via Svelte 5 runes. Panes read it; only the
// world selector and the boot sequence write to appState.

import { createLeaveGuards } from "./curated-lessons.ts";

/** A pane with unsaved work registers here; App asks before a world or pane change. */
export const leaveGuards = createLeaveGuards();

export const appState = $state({
  world: "default",
  worldNames: [] as string[],
  // Bumped by a pane after it changes something the rail counts. The shell
  // watches it, so the Review badge drops the moment you accept a proposal
  // instead of on the next ten second poll.
  statusSeq: 0,
  // Set by Artifacts' Refine action right before it navigates to #/review,
  // so Review opens the generated (or reopened) proposal in the same detail
  // view used for every other staged proposal, instead of leaving the
  // operator to find it in the list themselves. Review clears it once read.
  openReviewPattern: null as string | null,
});

export type ToastKind = "error" | "ok" | "info";

interface ToastValue {
  message: string;
  kind: ToastKind;
}

export const toastState = $state<{ current: ToastValue | null }>({ current: null });

let toastTimer: ReturnType<typeof setTimeout> | null = null;

export function toast(message: string, kind: ToastKind = "error"): void {
  toastState.current = { message, kind };
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastState.current = null;
  }, 6000);
}
