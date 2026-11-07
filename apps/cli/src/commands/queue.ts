// sil queue: put parked sessions back in line, after the reason they were
// parked has been fixed.

import { listQueueStrict, loadEntry, moveEntry, removeEntry } from "@sil/store";

export interface QueueRequeueOptions {
  failed?: boolean;
  world?: string;
  dryRun?: boolean;
}

/** Moves failed entries back to pending with a fresh attempt count.
 *
 * A provider outage parks an entry in `failed` after MAX_ATTEMPTS, and nothing
 * moves it back: the queue's `done` and `failed` buckets only ever grow. A
 * misconfigured model id parked 50 sessions that way, and every one of them
 * was still reflectable once llm.yaml named a model that exists. */
export async function cmdQueueRequeue(opts: QueueRequeueOptions): Promise<number> {
  if (!opts.failed) {
    console.error("error: sil queue requeue needs --failed");
    return 2;
  }
  // Strict: an unreadable bucket is a read error, not a smaller backlog.
  const entries = listQueueStrict("failed");
  const selected = opts.world === undefined ? entries : entries.filter((e) => e.world === opts.world);
  if (selected.length === 0) {
    console.log(`nothing to requeue in failed${opts.world === undefined ? "" : ` for world ${opts.world}`}`);
    return 0;
  }
  const worlds = new Map<string, number>();
  for (const entry of selected) worlds.set(entry.world, (worlds.get(entry.world) ?? 0) + 1);
  const byWorld = [...worlds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([w, n]) => `${w} ${n}`).join(", ");

  if (opts.dryRun) {
    console.log(`would requeue ${selected.length} session(s) from failed (${byWorld})`);
    return 0;
  }
  let requeued = 0;
  let duplicates = 0;
  for (const entry of selected) {
    // A crash between the write and the unlink leaves the session in both
    // buckets. Pending already holds the copy the worker would read, so the
    // failed one goes rather than turning one session into two reflections.
    if (loadEntry("pending", entry.session_id) !== null) {
      removeEntry("failed", entry.session_id);
      duplicates += 1;
      continue;
    }
    // attempts 0 so the entry gets its full budget against the fixed cause,
    // result null so a stale reason cannot read as this attempt's.
    moveEntry({ ...entry, attempts: 0, result: null }, "failed", "pending");
    requeued += 1;
  }
  const tail = duplicates > 0 ? `; dropped ${duplicates} already pending` : "";
  console.log(`requeued ${requeued} session(s) from failed (${byWorld})${tail}`);
  return 0;
}
