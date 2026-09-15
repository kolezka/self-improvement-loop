// Structural check for a nudge JSON document. Ported from sil/nudge.py's
// lint_nudge. Empty array means clean.

import { isSlug } from "@sil/core/consts";
import { LOW_FREQUENCY_EVENTS, gateTruth, splitTrigger, validateGate } from "./gates.ts";

export const MAX_TEXT = 400;
const ONCE_PER = new Set(["session", "always"]);

/** The one sentence lintNudge enforces, in prose a drafter can obey before
 * writing the body. */
export function unboundedBroadcastRule(): string {
  const low = [...LOW_FREQUENCY_EVENTS].sort().join(", ");
  return (
    "a gate that is true for every payload is accepted only when " +
    "something else bounds it: set 'once_per' to 'session', or use " +
    `one of the low-frequency events (${low}). An unconditional gate ` +
    "with 'once_per' set to 'always' on any other event is rejected outright"
  );
}

interface LintableNudge {
  pattern: string;
  event: string;
  gate: unknown;
  once_per: string;
  text: string;
  matcher?: string | null;
}

/** Reject an unbounded unconditional broadcast, not breadth on its own.
 * Indefensible only when all three hold: the gate discriminates nothing,
 * once_per is 'always' so not even one-per-session bounds it, and the event
 * fires many times per session. */
function lintUnboundedBroadcast(obj: LintableNudge): string[] {
  if (gateTruth(obj.gate) !== true) return [];
  if (obj.once_per === "session") return [];
  if (LOW_FREQUENCY_EVENTS.has(obj.event)) return [];
  return [
    `degenerate gate: it fires unconditionally, once_per is ` +
      `${JSON.stringify(obj.once_per)}, and ${obj.event} fires many times per ` +
      `session, this injects on every ${obj.event} forever and ` +
      `discriminates nothing. Narrow the gate to a real predicate, or ` +
      unboundedBroadcastRule(),
  ];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function lintNudge(obj: unknown): string[] {
  if (!isRecord(obj)) return ["nudge must be a JSON object"];

  const problems: string[] = [];
  for (const field of ["pattern", "event", "gate", "once_per", "text"]) {
    if (!(field in obj)) problems.push(`missing required field ${JSON.stringify(field)}`);
  }
  if (problems.length > 0) return problems;

  if (typeof obj["pattern"] !== "string") problems.push("field 'pattern' must be a string");
  else if (!isSlug(obj["pattern"])) problems.push(`field 'pattern' must be a slug, got ${JSON.stringify(obj["pattern"])}`);
  if (typeof obj["event"] !== "string") problems.push("field 'event' must be a string");
  if (!isRecord(obj["gate"])) problems.push("field 'gate' must be a dict");
  if (typeof obj["once_per"] !== "string") problems.push("field 'once_per' must be a string");
  if (typeof obj["text"] !== "string") problems.push("field 'text' must be a string");
  if (obj["matcher"] !== undefined && obj["matcher"] !== null && typeof obj["matcher"] !== "string") {
    problems.push("field 'matcher' must be a string or absent");
  }
  if (problems.length > 0) return problems;

  const event = obj["event"] as string;
  const matcher = obj["matcher"] as string | null | undefined;
  const text = obj["text"] as string;
  const oncePer = obj["once_per"] as string;

  const trigger = event + (matcher ? `:${matcher}` : "");
  const triggerOk = splitTrigger(trigger) !== null;
  if (!triggerOk) problems.push(`unsupported event/matcher: ${JSON.stringify(trigger)}`);
  const oncePerOk = ONCE_PER.has(oncePer);
  if (!oncePerOk) problems.push(`once_per must be one of ${[...ONCE_PER].sort().join(", ")}`);
  if (!text.trim()) problems.push("text must be a non-empty string");
  else if (text.length > MAX_TEXT) problems.push(`text is ${text.length} chars; the cap is ${MAX_TEXT}`);

  problems.push(...validateGate(obj["gate"]));

  // Needs all three of gate/once_per/event, so only checked once each is
  // individually well-formed.
  if (triggerOk && oncePerOk) {
    problems.push(
      ...lintUnboundedBroadcast({
        pattern: obj["pattern"] as string,
        event,
        gate: obj["gate"],
        once_per: oncePer,
        text,
        matcher,
      }),
    );
  }

  return problems;
}
