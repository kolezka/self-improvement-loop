// Reversible queue hide: "Clear done" / "Clear failed" record a cutoff
// timestamp. No queue file ever moves or is deleted for this.

import { z } from "zod";
import { fsx, paths, ValidationError } from "@sil/core";

const QueueClearedSchema = z.object({
  done: z.string().nullable(),
  failed: z.string().nullable(),
});

export interface QueueCleared {
  done: string | null;
  failed: string | null;
}

const DEFAULT_CLEARED: QueueCleared = { done: null, failed: null };

/** A missing file means nothing has been hidden yet. Anything else wrong
 * with it (torn JSON, permission denied, the wrong shape) must not read as
 * that same default: it would silently bring back every hidden session. */
export function loadQueueCleared(): QueueCleared {
  const path = paths.queueClearedFile();
  let text: string;
  try {
    text = fsx.readText(path);
  } catch (err) {
    if (err && typeof err === "object" && (err as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_CLEARED;
    throw new ValidationError(`cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new ValidationError(`invalid JSON in ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const result = QueueClearedSchema.safeParse(parsed);
  if (!result.success) throw new ValidationError(`invalid queue-cleared shape in ${path}: ${result.error.message}`);
  return result.data;
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
