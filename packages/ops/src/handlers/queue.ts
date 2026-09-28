import { fsx } from "@sil/core";
import { isHidden, listQueue, loadQueueCleared, setQueueCleared, type Bucket } from "@sil/store";
import type { ClearArgs, NoArgs, SessionArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";
import { spawnCli } from "../spawn.ts";

const QUEUE_LIST_CAP = 200;

function byLastStopDesc(a: { last_stop: string }, b: { last_stop: string }): number {
  return a.last_stop < b.last_stop ? 1 : a.last_stop > b.last_stop ? -1 : 0;
}

function capped(bucket: Bucket) {
  return [...listQueue(bucket)].sort(byLastStopDesc).slice(0, QUEUE_LIST_CAP);
}

// web console: history and queue ops
/** Entries not hidden by the bucket's clear cutoff, capped after hiding: the
 * cap bounds what the console renders, hidden counts the whole bucket. */
function visibleCapped(bucket: Bucket, clearedBefore: string | null): { visible: ReturnType<typeof listQueue>; hidden: number } {
  const all = listQueue(bucket);
  const shown = all.filter((e) => !isHidden(e, clearedBefore));
  return { visible: shown.sort(byLastStopDesc).slice(0, QUEUE_LIST_CAP), hidden: all.length - shown.length };
}

export function queueList(_args: NoArgs) {
  const cleared = loadQueueCleared();
  const done = visibleCapped("done", cleared.done);
  const failed = visibleCapped("failed", cleared.failed);
  return {
    pending: capped("pending"),
    done: done.visible,
    failed: failed.visible,
    hidden: { done: done.hidden, failed: failed.hidden },
    cleared,
  };
}

export function queueClear(args: ClearArgs) {
  return setQueueCleared(args.bucket, fsx.nowIso());
}

export function queueUnclear(args: ClearArgs) {
  return setQueueCleared(args.bucket, null);
}
// end: web console: history and queue ops

export function queueSkip(args: SessionArgs) {
  return { session_id: args.session_id, skipped: deps.worker.skipSession(args.session_id) };
}

export function workerStatus(_args: NoArgs) {
  return deps.worker.status();
}

export function loopRun(args: WorldArgs) {
  const [, world] = cfgWorld(args.world);
  return spawnCli(["worker", "--once", "--world", world.name], "worker");
}
