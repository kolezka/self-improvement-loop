// sil reflect: mark a pending queue entry ended, optionally run the worker now.

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig, type QueueEntry } from "@sil/core";
import { listQueue, loadEntry, writeEntry } from "@sil/store";
import { defaultDeps, type Deps } from "../deps.ts";

export interface ReflectOptions {
  session?: string;
  cwd?: string;
  now?: boolean;
}

function realOrResolve(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

/** The pending entry for `--session`, or the newest un-ended entry for
 * `--cwd`. Matches the hook's own cwd storage: an exact string match after
 * resolving symlinks, same as `core.config.worldForCwd`. */
function findPendingEntry(opts: ReflectOptions): QueueEntry | null {
  if (opts.session) {
    const bySession = loadEntry("pending", opts.session);
    if (bySession) return bySession;
  }
  if (!opts.cwd) return null;

  const cwd = realOrResolve(opts.cwd);
  let best: QueueEntry | null = null;
  for (const e of listQueue("pending")) {
    if (e.cwd !== cwd || e.ended) continue;
    if (!best || e.last_stop > best.last_stop) best = e;
  }
  return best;
}

export async function cmdReflect(opts: ReflectOptions, deps: Deps = defaultDeps): Promise<number> {
  if (!opts.session && !opts.cwd) {
    console.error("error: sil reflect needs --session or --cwd");
    return 2;
  }

  const entry = findPendingEntry(opts);
  if (!entry) {
    console.error("no matching pending queue entry found");
    return 2;
  }

  entry.ended = true;
  writeEntry("pending", entry);
  console.log(`marked ${entry.session_id} ended`);

  if (opts.now) {
    const cfg = loadConfig();
    const result = await deps.worker.runOnce(cfg, { worldName: entry.world, reflect: true, curriculum: false });
    console.log(`worker ran: ${JSON.stringify(result)}`);
  }
  return 0;
}
