// The handlers' one-record writers for usage events and hook runs. Both go
// through hookWrite: a loop state row when the database is ready, else a
// spill to the old file (design D5). Spool ingest writes its groups itself.

import { hookWrite } from "@sil/statedb/hook";
import { log } from "./log.ts";

// One hook.log line per writer per process when a record is lost, so a
// standing failure (bad permissions, full disk) does not log on every call.
// Separate keys: a lost hook run must not silence the first lost usage event.
const lostLogged = new Set<string>();

function reportLost(writer: string, detail: string): void {
  if (lostLogged.has(writer)) return;
  lostLogged.add(writer);
  log(`${writer} failed: ${detail}`);
}

/** Write one usage event. Never throws: a failure here must not break a hook
 * invocation, so it goes to the hook log instead. */
export function appendUsageEvent(event: Record<string, unknown>): void {
  try {
    if (hookWrite("usage_events", [event]) === "lost") reportLost("usage.append_event", "record lost, see the loop state lines above");
  } catch (e) {
    reportLost("usage.append_event", (e as Error).message);
  }
}

/** Write one hook_run diagnostic record. Same never-throw contract as
 * `appendUsageEvent`; the worker trims these rows (design D11). */
export function appendHookRun(event: Record<string, unknown>): void {
  try {
    if (hookWrite("hook_runs", [event]) === "lost") reportLost("usage.append_hook_run", "record lost, see the loop state lines above");
  } catch (e) {
    reportLost("usage.append_hook_run", (e as Error).message);
  }
}
