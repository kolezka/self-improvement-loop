// Load nudges from disk and dispatch at most one per hook call. Ported from
// sil/nudge.py's load_nudges and dispatch.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { readJsonOr } from "@sil/core/fsx";
import { appendLine, claimMarker, writeBreadcrumb } from "./firelog.ts";
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

export interface DispatchOptions {
  sessionDir: string;
  fireLog: string;
  budgetMs?: number;
  // Bun cannot preempt a running regex, so this is not a cutoff: a gate that
  // runs past it logs a `gate_overrun` breadcrumb after the fact. The real
  // bound on a single gate is that loadNudges refuses to hand dispatch a
  // pattern lint rejected (see gates.ts's comment on the three defences).
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

/** All nudges from `dirs`, sorted by filename within each dir, dirs in the
 * order given, alongside the files that were refused and why.
 *
 * Every file goes through the full lintNudge (which runs validateGate, which
 * runs isUnsafeRegex) before it can be dispatched. A hand-placed nudge with a
 * catastrophic regex is the one case gates.ts cannot defend against once the
 * match starts, so it has to be stopped here, at load, rather than reported
 * by a linter nobody ran. Loading still never throws: a rejected file costs
 * itself, never the other nudges in the directory. */
export function loadNudgesDetailed(dirs: string[]): LoadedNudges {
  const nudges: Nudge[] = [];
  const rejected: RejectedNudge[] = [];
  for (const d of dirs) {
    let names: string[];
    try {
      names = readdirSync(d).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(d, name);
      const raw = readJsonOr<unknown>(file, null);
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
  }
  return { nudges, rejected };
}

/** loadNudgesDetailed without the rejection list, for callers that only
 * dispatch. */
export function loadNudges(dirs: string[]): Nudge[] {
  return loadNudgesDetailed(dirs).nudges;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** Fire at most one nudge: the first (in list order) whose event/matcher
 * match, whose gate is true, and whose once_per marker is free. The marker
 * is claimed, and the fire logged, only for the winner: a nudge that
 * matches but loses to an earlier one keeps its slot for a later call
 * instead of burning it on a delivery that never happened. Never throws. */
export function dispatch(payload: Record<string, unknown>, nudges: Nudge[], opts: DispatchOptions): string | null {
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
        writeBreadcrumb(opts.fireLog, opts.sessionDir, "gate_overrun", sessionId, event, {
          pattern,
          elapsed_ms: Math.round(elapsedMs),
          budget_ms: gateTimeoutMs,
        });
      }

      if (!matched) continue;

      if (nudge["once_per"] !== "always") {
        // Anything other than the literal "always" is session-scoped: fail
        // closed on an unrecognised once_per, not open.
        if (!claimMarker(opts.sessionDir, `nudge-${pattern}`)) continue;
      }

      appendLine(opts.fireLog, JSON.stringify({ ts: new Date().toISOString(), pattern, session_id: sessionId, event }));
      return str(nudge["text"]);
    }

    if (budgetExhausted) {
      writeBreadcrumb(opts.fireLog, opts.sessionDir, "gate_budget_exhausted", sessionId, event, { scanned });
    }
    return null;
  } catch {
    return null;
  }
}
