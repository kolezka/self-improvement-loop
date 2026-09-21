// The part of loading and dispatching nudges that touches no filesystem.
// dispatch.ts supplies a Node sink built on firelog.ts; the sandboxed hooks
// module supplies its own. Timing uses performance.now(), a web global, so
// this file needs no Node globals at all.

import { evaluate } from "./gates.ts";
import { lintNudge } from "./lint.ts";

export type Gate = Record<string, unknown>;

export interface Nudge {
  pattern: string;
  event: string;
  matcher?: string;
  gate: Gate;
  once_per: "session" | "always";
  text: string;
}

export interface RejectedNudge {
  file: string;
  problems: string[];
}

export interface LoadedNudges {
  nudges: Nudge[];
  rejected: RejectedNudge[];
}

export interface DispatchSink {
  /** True the first time `name` is claimed in this session, false after.
   * Fails closed: any failure is false, never a free claim. */
  claimMarker(name: string): boolean;
  fire(record: { ts: string; pattern: string; session_id: string; event: string }): void;
  breadcrumb(record: { ts: string; kind: string; session_id: string; event: string } & Record<string, unknown>): void;
}

export interface DispatchBudget {
  budgetMs?: number;
  gateTimeoutMs?: number;
}

const DEFAULT_BUDGET_MS = 250;
const DEFAULT_GATE_TIMEOUT_MS = 50;
// The smallest slice of budget worth starting a gate for. Below this, stop
// scanning and log why: mirrors sil/nudge.py's GATE_MIN_SLICE_S. This bounds
// total time spent across a *list* of gates; it cannot bound a single gate
// that is already running (see gates.ts's comment on regex safety).
const GATE_MIN_SLICE_MS = 5;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Capped at one record per (session, kind, event): an anomaly that never
 * clears would otherwise write on every matching call for the rest of the
 * session. Same dedupe key and same field order as firelog's writeBreadcrumb,
 * so the line on disk is unchanged. */
function breadcrumb(
  sink: DispatchSink,
  kind: string,
  sessionId: string,
  event: string,
  extra: Record<string, unknown>,
): void {
  if (!sink.claimMarker(`breadcrumb-${kind}-${event}`)) return;
  sink.breadcrumb({ ts: new Date().toISOString(), kind, session_id: sessionId, event, ...extra });
}

/** Fire at most one nudge: the first (in list order) whose event/matcher
 * match, whose gate is true, and whose once_per marker is free. The marker
 * is claimed, and the fire logged, only for the winner: a nudge that
 * matches but loses to an earlier one keeps its slot for a later call
 * instead of burning it on a delivery that never happened. Never throws. */
export function dispatchWith(
  payload: Record<string, unknown>,
  nudges: Nudge[],
  sink: DispatchSink,
  opts: DispatchBudget = {},
): string | null {
  try {
    const sessionId = str(payload["session_id"], "unknown");
    const event = str(payload["hook_event_name"]);
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;

    let gateSpentMs = 0;
    let scanned = 0;
    let budgetExhausted = false;

    for (const nudge of nudges) {
      scanned++;
      if (!isRecord(nudge) || nudge["event"] !== event) continue;
      const matcher = nudge["matcher"];
      if (matcher && payload["tool_name"] !== matcher) continue;

      // Charged only for nudges that actually reach a gate: an event or
      // matcher miss is free, so a directory full of unreachable nudges
      // cannot exhaust the budget for the one that is reachable.
      const remaining = budgetMs - gateSpentMs;
      if (remaining < GATE_MIN_SLICE_MS) {
        budgetExhausted = true;
        break;
      }

      const started = performance.now();
      const matched = evaluate(nudge["gate"], payload);
      const elapsedMs = performance.now() - started;
      gateSpentMs += elapsedMs;

      const pattern = str(nudge["pattern"], "unknown");
      if (elapsedMs > gateTimeoutMs) {
        breadcrumb(sink, "gate_overrun", sessionId, event, {
          pattern,
          elapsed_ms: Math.round(elapsedMs),
          budget_ms: gateTimeoutMs,
        });
      }

      if (!matched) continue;

      if (nudge["once_per"] !== "always") {
        // Anything other than the literal "always" is session-scoped: fail
        // closed on an unrecognised once_per, not open.
        if (!sink.claimMarker(`nudge-${pattern}`)) continue;
      }

      sink.fire({ ts: new Date().toISOString(), pattern, session_id: sessionId, event });
      return str(nudge["text"]);
    }

    if (budgetExhausted) {
      breadcrumb(sink, "gate_budget_exhausted", sessionId, event, { scanned });
    }
    return null;
  } catch {
    return null;
  }
}

/** The pure half of loadNudgesDetailed: the files are already read. Order is
 * preserved, and a rejected file costs itself, never its neighbours.
 *
 * Every file goes through the full lintNudge (which runs validateGate, which
 * runs isUnsafeRegex) before it can be dispatched. A hand-placed nudge with a
 * catastrophic regex is the one case gates.ts cannot defend against once the
 * match starts, so it has to be stopped here, at load, rather than reported
 * by a linter nobody ran. */
export function lintLoadedNudges(files: Array<{ file: string; raw: unknown }>): LoadedNudges {
  const nudges: Nudge[] = [];
  const rejected: RejectedNudge[] = [];
  for (const { file, raw } of files) {
    if (!isRecord(raw)) {
      rejected.push({ file, problems: ["not readable as a JSON object"] });
      continue;
    }
    const problems = lintNudge(raw);
    if (problems.length > 0) {
      rejected.push({ file, problems });
      continue;
    }
    nudges.push(raw as unknown as Nudge);
  }
  return { nudges, rejected };
}
