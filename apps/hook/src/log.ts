// hook.log helpers. Ported from sil/hook.py's _now_iso, _log, _exc_summary.

import * as paths from "@sil/core/paths";
import { appendLine } from "@sil/nudges";

export function nowIso(): string {
  return new Date().toISOString();
}

/** Append one line to the hook log. Never throws: a logging failure must
 * never take down the hook invocation that triggered the log line. */
export function log(msg: string): void {
  try {
    appendLine(paths.logFile("hook"), `${nowIso()} ${msg}`);
  } catch {
    // logging must never break the hook
  }
}

/** Type name plus a short, bounded piece of the message. Never the payload:
 * a handler exception can carry secrets from the tool call. */
export function excSummary(e: unknown): string {
  const name = e instanceof Error ? e.constructor.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message.slice(0, 120)}`;
}
