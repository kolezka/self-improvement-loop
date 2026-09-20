// The artifact-type decision. Total: every input yields a RouteResult.
//
// Why this module exists: the loop could only ever emit a SKILL.md, and a skill
// is agent-invoked. Measured in V1 across 2997 transcripts, the five promoted
// skills were invoked 0/1/0/0/0 times while being listed in 1301 sessions. The
// trigger condition for a discipline is invisible from inside the context that
// would have to act on it, so no description rewrite reaches it.
//
// The order below is deliberate. `hook` is first because it is the only type
// that does not depend on the agent recognising its own failure, and because its
// claim is the only one that can be tested by running it. `skill` is last among
// the real types and has to be paid for with a verbatim quote, inverting the old
// default in which everything became a skill because skill was the fallback.
//
// Gate timeout: a gate is model authored, and an innocuous `(a+)+` backtracks
// exponentially. A regex is not interruptible from inside the process, so the
// corpus walk runs out of process behind a wall-clock deadline (`runGateCorpus`)
// and a run that does not answer in time refuses the hook.

import { SECTIONS } from "@sil/core";
import { z } from "zod";
import { type GateRunner, nudgeEvents, nudges } from "./deps.ts";
import { distinctiveTerms } from "./lint.ts";

// A gate that cannot be evaluated inside the deadline does not route to hook.
export const GATE_TIMEOUT_MS = 250;

// What a quote has to be before it buys an artifact type. A bare substring test
// let `"a"`, `"."` and `"the"` through, which is every string: the evidence
// requirement that separates skill and agent from rule was satisfiable by typing
// one character.
export const MIN_QUOTE_WORDS = 5;
export const MIN_QUOTE_CHARS = 30;
// Length and word count are both payable with the reflection template's own
// scaffolding: "Last updated: 2026-09-01 Pattern: verify-callsites" is five
// words and fifty characters, and is verbatim in every reflection ever written.
// So a quote must also carry words that say something about this lesson.
export const MIN_QUOTE_TERMS = 3;

/** What the drafter returns instead of choosing a type in prose. */
export const RouteAnswer = z.object({
  trigger_event: z.string().default("none"),
  gate: z.record(z.string(), z.unknown()).nullable().default(null),
  needs_own_context: z.boolean().default(false),
  // The quote that makes `needs_own_context` checkable, exactly as
  // capability_evidence does for `skill`. A bare bool was the one signal nothing
  // could falsify, and that is precisely where the measured routing variance
  // sat: same pattern, same prompt, rule on one run and agent on the next.
  context_evidence: z.string().nullable().default(null),
  capability_evidence: z.string().nullable().default(null),
  // The drafter's own "no artifact is warranted here". A field, not a caller
  // keyword: a pattern recurring 149 times may mean the discipline is inherent,
  // and the drafter is the only party that can say so.
  no_artifact: z.boolean().default(false),
  // Why the reply could not be read. Distinct from `no_artifact`: a broken
  // transport and a considered refusal both used to print the same line, so an
  // unattended operator could not tell a dead provider from a working one with
  // nothing to say.
  parse_error: z.string().default(""),
});
export type RouteAnswer = z.infer<typeof RouteAnswer>;

export const emptyAnswer = (): RouteAnswer => RouteAnswer.parse({});

export interface RouteResult {
  artifact_type: "skill" | "hook" | "rule" | "agent" | "none";
  reason: string;
}

export interface RouteOptions {
  /** Injected corpus runner. Defaults to the nudge package's out-of-process one. */
  gateRunner?: GateRunner;
  timeoutMs?: number;
}

/** `"PreToolUse:Bash"` -> `["PreToolUse", "Bash"]`. null if unsupported.
 *
 * null covers every rejection (unknown event, a matcher on an event that takes
 * none, a matcher the dispatcher does not handle) so the caller checks one thing
 * rather than four. */
export function splitTrigger(trigger: string): [string, string | null] | null {
  const events = nudgeEvents();
  if (!events) return null;
  const raw = String(trigger ?? "");
  const at = raw.indexOf(":");
  const event = at === -1 ? raw : raw.slice(0, at);
  const matcher = at === -1 ? "" : raw.slice(at + 1);
  if (!Object.hasOwn(events, event)) return null;
  const allowed = events[event];
  // Every supported event is valid bare: "PreToolUse" means all matchers.
  if (!matcher) return [event, null];
  if (allowed === null || allowed === undefined || !allowed.has(matcher)) return null;
  return [event, matcher];
}

/** Whitespace-insensitive compare. The drafter re-wraps a quote it copied out of
 * a reflection, so an exact `includes` rejects genuine evidence over a newline.
 * Case is kept: a quote is a quote. */
function normalise(text: string): string {
  return text.split(/\s+/).filter(Boolean).join(" ");
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const SECTION_HEADINGS = new Set<string>(SECTIONS.map((heading) => heading.trim()));
const TEMPLATE_LINE = /^(Pattern|Last updated):/;

/** The sources with the reflection template's own lines removed.
 *
 * Those lines are in every reflection, so a quote made of them is verbatim in
 * all of them. Dropping them from the haystack is what stops the skill branch
 * being bought with a date and a heading. */
function withoutScaffolding(text: string): string {
  return text
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !TEMPLATE_LINE.test(trimmed) && !SECTION_HEADINGS.has(trimmed);
    })
    .join("\n");
}

/** Whether `note` is a real passage lifted out of `sourcesText`.
 *
 * Four things at once, and all four are needed. Length, so a token that
 * appears in every English sentence cannot stand in for evidence. Word count,
 * for the same reason. Distinctive terms, so the template's own scaffolding does
 * not qualify. And word-boundary alignment, so "safe" does not count as quoted
 * because the source says "unsafe". */
export function substantiveQuote(note: string | null | undefined, sourcesText: string): boolean {
  const quote = normalise(note ?? "");
  if (quote.length < MIN_QUOTE_CHARS || quote.split(" ").filter(Boolean).length < MIN_QUOTE_WORDS) return false;
  if (distinctiveTerms(quote).size < MIN_QUOTE_TERMS) return false;
  const haystack = normalise(withoutScaffolding(sourcesText ?? ""));
  return new RegExp(`(?<!\\w)${escapeRe(quote)}(?!\\w)`).test(haystack);
}

/** Which artifact this pattern should become, and why.
 *
 * Total. Callers gate on `artifact_type === "none"`, never on a throw: a router
 * that threw would take a whole curriculum run down for one malformed drafter
 * answer. Inputs are coerced rather than asserted, because a caller handing null
 * from a failed file read must cost a routing decision, not a crash. */
export function route(
  answer: unknown,
  sourcesText: unknown,
  payloads: unknown,
  opts: RouteOptions = {},
): RouteResult {
  // Coerced, never asserted. `null`, `{}` and a stray number all become the
  // empty answer, which routes to `rule` like any other unevidenced discipline.
  const reply = RouteAnswer.safeParse(answer).data ?? emptyAnswer();
  const sources = typeof sourcesText === "string" ? sourcesText : "";
  const corpus = Array.isArray(payloads) ? (payloads as Record<string, unknown>[]) : [];

  // Before `no_artifact`, and reported differently: an unreadable reply is a
  // provider problem someone has to fix, while a decline is the drafter working
  // correctly and saying no.
  if (reply.parse_error) {
    return { artifact_type: "none", reason: `unreadable drafter reply: ${reply.parse_error}` };
  }

  // First among the model's own signals, so an explicit decline is not
  // overridden by a gate that happens to fire. Otherwise the churn relocates
  // from skills to hooks.
  if (reply.no_artifact) {
    return { artifact_type: "none", reason: "drafter declined: no artifact warranted" };
  }

  const verdict = hookVerdict(reply, corpus, opts);
  if (typeof verdict !== "string") {
    return {
      artifact_type: "hook",
      reason: `gate fires on ${verdict.hits} of ${verdict.total} recorded payload(s) at ${reply.trigger_event}`,
    };
  }
  const hookReason = verdict;

  // `agent` is earned, not asserted, at the same bar `skill` clears below.
  if (reply.needs_own_context) {
    const note = (reply.context_evidence ?? "").trim();
    if (!note) {
      return {
        artifact_type: "rule",
        reason: "needs_own_context asserted with no context_evidence; an unevidenced boolean does not buy an agent",
      };
    }
    if (!substantiveQuote(note, sources)) {
      return {
        artifact_type: "rule",
        reason:
          `context_evidence is not verbatim in any source reflection (needs at least ${MIN_QUOTE_WORDS} words, ` +
          `${MIN_QUOTE_CHARS} characters and ${MIN_QUOTE_TERMS} distinctive terms, matched on word boundaries ` +
          "against the sources with the reflection template's own lines removed); treated as a discipline",
      };
    }
    return { artifact_type: "agent", reason: "own-context need quoted verbatim from a source" };
  }

  const quote = (reply.capability_evidence ?? "").trim();
  if (quote) {
    if (substantiveQuote(quote, sources)) {
      return { artifact_type: "skill", reason: "capability evidence quoted verbatim from a source" };
    }
    return {
      artifact_type: "rule",
      reason:
        `capability_evidence is not verbatim in any source reflection (needs at least ${MIN_QUOTE_WORDS} words, ` +
        `${MIN_QUOTE_CHARS} characters and ${MIN_QUOTE_TERMS} distinctive terms, matched on word boundaries ` +
        "against the sources with the reflection template's own lines removed); treated as a discipline",
    };
  }

  return {
    artifact_type: "rule",
    reason: `no workable gate (${hookReason}), no own-context need, no capability evidence`,
  };
}

// A gate firing on more than this share of recorded tool calls is a broadcast.
// "Fires on every payload" was the whole check when the corpus was twenty
// fixtures; against two thousand recorded calls nothing but `always` ever
// matches every one, and a gate on half of them would pass as narrow.
export const MAX_GATE_MATCH_RATE = 0.5;

/** The hit count when the answer is a workable hook, otherwise why it is not.
 *
 * The gate is executed against the recorded payload corpus rather than read.
 * "This is mechanically detectable" is a claim the drafter makes, and the point
 * of this module is that such claims get tested. */
function hookVerdict(
  answer: RouteAnswer,
  payloads: Record<string, unknown>[],
  opts: RouteOptions,
): string | { hits: number; total: number } {
  const gate = answer.gate;
  if (answer.trigger_event === "none" || gate == null || Object.keys(gate).length === 0) {
    return "no trigger event proposed";
  }
  if (splitTrigger(answer.trigger_event) === null) {
    return `unsupported event/matcher ${JSON.stringify(answer.trigger_event)}`;
  }
  if (payloads.length === 0) return "no recorded payloads to test the gate against";

  const runner = opts.gateRunner ?? nudges().runGateCorpus;
  if (!runner) return "nudge dispatcher unavailable: no gate runner";
  const timeoutMs = opts.timeoutMs ?? GATE_TIMEOUT_MS;

  let outcome;
  try {
    outcome = runner(gate, payloads, timeoutMs);
  } catch (e) {
    // Total: any runner bug is a refusal, never a dead curriculum run.
    return `gate runner raised ${(e as Error).name || "Error"}`;
  }
  if (outcome.timedOut) return `gate evaluation timed out after ${timeoutMs}ms`;
  if (outcome.error) return `gate rejected: ${outcome.error}`;
  const results = Array.isArray(outcome.results) ? outcome.results : [];
  if (results.length !== payloads.length) {
    return `gate runner answered for ${results.length} of ${payloads.length} payload(s)`;
  }

  const hits = results.filter(Boolean).length;
  if (hits === 0) return "gate matched nothing in the payload corpus";
  if (payloads.length > 1 && hits / payloads.length > MAX_GATE_MATCH_RATE) {
    // It would inject on a large share of the tool calls of every session.
    return `gate fires on ${hits} of ${payloads.length} recorded payloads; that is a broadcast, not a nudge`;
  }
  return { hits, total: payloads.length };
}
