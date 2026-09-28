// Reversible queue hide: "Clear done" / "Clear failed" record a cutoff
// timestamp. No queue file ever moves or is deleted for this.

import { fsx, paths } from "@sil/core";

export interface QueueCleared {
  done: string | null;
  failed: string | null;
}

const DEFAULT_CLEARED: QueueCleared = { done: null, failed: null };

export function loadQueueCleared(): QueueCleared {
  return fsx.readJsonOr<QueueCleared>(paths.queueClearedFile(), DEFAULT_CLEARED);
}

export function setQueueCleared(bucket: "done" | "failed", iso: string | null): QueueCleared {
  const next = { ...loadQueueCleared(), [bucket]: iso };
  fsx.writeJson(paths.queueClearedFile(), next);
  return next;
}

/** An entry is hidden once its `last_stop` is at or before the cutoff.
 * Compared as instants, not strings: an entry and the cutoff can carry
 * different UTC offsets even though both are ISO timestamps. */
export function isHidden(entry: { last_stop: string }, clearedBefore: string | null): boolean {
  if (clearedBefore === null) return false;
  return Date.parse(entry.last_stop) <= Date.parse(clearedBefore);
}
