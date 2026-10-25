// Reversible queue hide: "Clear done" / "Clear failed" record a cutoff
// timestamp in loop state. No queue file ever moves or is deleted for this.

import { z } from "zod";
import { StateReadError, ValidationError } from "@sil/core";
import { readDoc, saveDoc } from "@sil/statedb";

const QueueClearedSchema = z.object({
  done: z.string().nullable(),
  failed: z.string().nullable(),
});

export interface QueueCleared {
  done: string | null;
  failed: string | null;
}

const DEFAULT_CLEARED: QueueCleared = { done: null, failed: null };

/** No row means nothing has been hidden yet. Anything else wrong with the
 * cutoffs (a legacy file that cannot be imported, the wrong shape) must not
 * read as that same default: it would silently bring back every hidden session. */
// The consoles show these messages: a short name and a reason, never the
// absolute path, the parser's text or the file's content.
const LABEL = "the queue cutoffs";

export function loadQueueCleared(): QueueCleared {
  let doc: Record<string, unknown> | null;
  try {
    doc = readDoc("queue_cleared", null, "strict");
  } catch (err) {
    if (err instanceof StateReadError) throw new ValidationError(err.message);
    throw err;
  }
  if (doc === null) return DEFAULT_CLEARED;
  const result = QueueClearedSchema.safeParse(doc);
  if (!result.success) throw new ValidationError(`${LABEL} do not have the expected shape`);
  return result.data;
}

export function setQueueCleared(bucket: "done" | "failed", iso: string | null): QueueCleared {
  const next = { ...loadQueueCleared(), [bucket]: iso };
  saveDoc("queue_cleared", null, next);
  return next;
}

/** An entry is hidden once its `last_stop` is at or before the cutoff.
 * Compared as instants, not strings: an entry and the cutoff can carry
 * different UTC offsets even though both are ISO timestamps. */
export function isHidden(entry: { last_stop: string }, clearedBefore: string | null): boolean {
  if (clearedBefore === null) return false;
  return Date.parse(entry.last_stop) <= Date.parse(clearedBefore);
}
