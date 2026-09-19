// Shared, mutable app state via Svelte 5 runes. Panes read it; only the
// world selector and the boot sequence write to appState.

export const appState = $state({
  world: "default",
  worldNames: [] as string[],
  // Bumped by a pane after it changes something the rail counts. The shell
  // watches it, so the Review badge drops the moment you accept a proposal
  // instead of on the next ten second poll.
  statusSeq: 0,
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
