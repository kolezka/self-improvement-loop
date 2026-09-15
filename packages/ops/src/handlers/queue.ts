import { listQueue, type Bucket } from "@sil/store";
import type { NoArgs, SessionArgs, WorldArgs } from "../args.ts";
import { cfgWorld } from "../cfg-world.ts";
import { deps } from "../deps.ts";
import { spawnCli } from "../spawn.ts";

const QUEUE_LIST_CAP = 200;

function capped(bucket: Bucket) {
  const entries = [...listQueue(bucket)].sort((a, b) => (a.last_stop < b.last_stop ? 1 : a.last_stop > b.last_stop ? -1 : 0));
  return entries.slice(0, QUEUE_LIST_CAP);
}

export function queueList(_args: NoArgs) {
  return { pending: capped("pending"), done: capped("done"), failed: capped("failed") };
}

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
