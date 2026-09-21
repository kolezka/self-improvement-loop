// Usage-event and hook-run append helpers, shared by handlers.ts and
// spool-ingest.ts. Split out of handlers.ts so spool-ingest (which handlers.ts
// calls into from handleStop/handleSessionEnd) does not import handlers.ts
// back and create a cycle.

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import * as paths from "@sil/core/paths";
import { appendLine } from "@sil/core/fsx";
import { log } from "./log.ts";

// Set on the first failed write in this process, so a consistently broken
// path (bad permissions, full disk) writes one line to hook.log instead of
// one per hook invocation for the rest of the process.
let usageFailureLogged = false;

/** Append one JSON line to `path`. Never throws: a failure here must not
 * break a hook invocation, so it goes to the hook log instead. */
export function appendUsageEvent(path: string, event: Record<string, unknown>): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(event)}\n`, { encoding: "utf8", flag: "a" });
  } catch (e) {
    if (usageFailureLogged) return;
    usageFailureLogged = true;
    log(`usage.append_event failed for ${path}: ${(e as Error).message}`);
  }
}

// One tool call in a hooked session writes several hook_run lines, about 10k
// per day here. They are diagnostics, so the file rotates instead of growing.
export const HOOK_RUNS_ROTATE_AT_BYTES = 8 * 1024 * 1024;
export const HOOK_RUNS_KEEP_LINES = 40_000;

// Own flag, not usageFailureLogged: a broken hook-runs.jsonl must not silence
// the first failure on events.jsonl.
let hookRunFailureLogged = false;

/** Append one hook_run diagnostic line. Same never-throw contract as
 * `appendUsageEvent`, plus rotation. */
export function appendHookRun(event: Record<string, unknown>): void {
  try {
    appendLine(paths.hookRunsFile(), JSON.stringify(event), HOOK_RUNS_ROTATE_AT_BYTES, HOOK_RUNS_KEEP_LINES);
  } catch (e) {
    if (hookRunFailureLogged) return;
    hookRunFailureLogged = true;
    log(`usage.append_hook_run failed: ${(e as Error).message}`);
  }
}
