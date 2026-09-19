// Drafter and judge prompts, and the parsers for their replies.
//
// Both roles run through the provider with `jsonMode: true`, so the reply is one
// JSON object rather than V1's fenced blocks. The parsers live beside the
// prompts on purpose: they are two halves of one contract, and V1 paid for
// letting them drift into different modules.
//
// The artifact shapes are described in prose, never templated. Two V1 shapes
// failed by being copied: an angle-bracket placeholder was emitted verbatim as a
// description, and a filled-in worked example was reproduced as the body along
// with the instructions, passing both lint and the judge. Describing the shape
// risks only a malformed delimiter, which lint catches reliably. Prefer the
// failure mode the gates catch.

import { ruleTag } from "@sil/core";
import type { ChatMessage } from "@sil/providers";
import { nudgeEvents } from "./deps.ts";
// The rule cap, imported rather than restated: a prompt quoting a number the
// lint no longer uses is a gate the drafter cannot see.
import { MAX_RULE_CHARS } from "./lint.ts";
// The router's own bar for a quote, imported rather than restated. A prompt
// asking for "an exact substring" while the router demands five words is a
// drafter answering honestly and being downgraded for it on every run.
import { emptyAnswer, MIN_QUOTE_CHARS, MIN_QUOTE_TERMS, MIN_QUOTE_WORDS, RouteAnswer } from "./router.ts";

// Bound the evidence handed to a model, and never truncate it silently. The
// omission note stays in the prompt and says which end was dropped: a model that
// can see it was handed a window can hedge, one silently fed a fifth of the
// evidence writes with false confidence.
//
// Sized for reflection sections, not lesson lines: a live 57-reflection cluster
// is about 120 KB of drafting text, and a 32k-context local model holds about
// this much and no more.
export const MAX_SOURCE_CHARS = 120_000;

const FENCE_RE = /^```[A-Za-z]*\s*\n([\s\S]*?)\n?```\s*$/;
const THINK_RE = /^\s*<think>[\s\S]*?<\/think>\s*/i;

/** Lesson text for a prompt, newest first for selection and date order to read.
 *
 * `lessons` arrives oldest first. Filling the budget from that end drops the
 * newest, which is the exact reverse of what a maturing pattern needs: the most
 * recent lessons are the ones that correct it. */
export function boundedSources(lessons: string[]): string {
  const kept: string[] = [];
  let total = 0;
  for (const raw of [...lessons].reverse()) {
    const text = (raw ?? "").trim();
    if (total + text.length > MAX_SOURCE_CHARS && kept.length > 0) break;
    kept.push(text);
    total += text.length;
  }
  kept.reverse();
  if (kept.length < lessons.length) {
    kept.unshift(
      `[${lessons.length - kept.length} older reflection(s) omitted to fit the drafting context; the ${kept.length} most recent of ${lessons.length} are included]`,
    );
  }
  return kept.join("\n\n---\n\n");
}

// --- artifact shapes ---------------------------------------------------------

export function skillShape(pattern: string): string {
  return (
    "A markdown file. Line 1 is three hyphens alone. Then a line 'name:' " +
    `followed by exactly ${pattern}. Then a line 'description:' followed by ` +
    "'Use when ' and one specific trigger situation drawn from the lessons " +
    "below, at most two sentences. Then three hyphens alone on their own " +
    "line. Then a markdown '## ' heading naming the action to take, then the " +
    "guidance: imperative, specific, over 80 characters, naming the actual " +
    "commands, fields or checks the lessons name."
  );
}

export function agentShape(pattern: string): string {
  return (
    "The same file shape as a skill: three hyphens alone, a line 'name:' " +
    `followed by exactly ${pattern}, a line 'description:' followed by 'Use ` +
    "when ' and one specific trigger situation, then three hyphens alone. " +
    "Then a markdown '## ' heading, then the sub-agent's brief: what it " +
    "investigates, what it must read, what it reports back. Over 80 " +
    "characters, naming the actual commands, fields or checks the lessons name."
  );
}

export function ruleShape(pattern: string): string {
  // The lint caps the line the writer produces, tag included, so the budget the
  // drafter gets has to have the tag taken out of it already. Quoting the raw
  // cap asks for a bullet that is then refused for being 18 characters over,
  // which is an honest drafter gated on every run and never told why.
  const budget = MAX_RULE_CHARS - ruleTag(pattern).length - 1;
  return (
    `Exactly one line, starting with '- ', at most ${budget} characters. No heading, ` +
    "no frontmatter, no second line: the single imperative the agent must " +
    "follow, naming the actual command or check the lessons name. No HTML " +
    "comment and no '<!--rule:...-->' tag: the writer adds the tag itself."
  );
}

// Predicate -> what it takes, in the drafter's own words. Prose, never a JSON
// template: one V1 template was an angle-bracket example and the drafter emitted
// it verbatim. A drafter asked for a gate with no vocabulary in front of it
// invents one; four consecutive forced drafts produced four made-up predicates.
export const GATE_VOCABULARY: Record<string, string> = {
  always: "taking true, which fires on every matching call",
  tool_is: "taking a list of tool names",
  command_matches: "taking a regex string, matched against the Bash command",
  file_path_matches: "taking a glob string, matched against the file path",
  prompt_matches: "taking a regex string, matched against the user's prompt",
  all: "taking a list of predicates, true when every one of them is true",
  any: "taking a list of predicates, true when at least one is true",
  not: "taking a single predicate and inverting it",
};

/** (event list, matcher list) from the dispatcher, so the prompt cannot drift
 * away from the interpreter that has to execute what it asks for. */
function eventVocabulary(): [string, string] {
  const events = nudgeEvents();
  if (!events) {
    return [
      "PreToolUse, PostToolUse, Stop, SessionStart, UserPromptSubmit",
      "Bash, Edit, Write, Read, Grep, Glob, Agent",
    ];
  }
  const matchers = new Set<string>();
  for (const allowed of Object.values(events)) {
    if (allowed) for (const m of allowed) matchers.add(m);
  }
  return [Object.keys(events).sort().join(", "), [...matchers].sort().join(", ")];
}

/** Self-contained: it names the gate vocabulary itself, because the forced
 * (re-home) prompt carries nothing else that would. */
export function hookShape(pattern: string): string {
  const [events, matchers] = eventVocabulary();
  const vocab = Object.keys(GATE_VOCABULARY)
    .sort()
    .map((name) => `'${name}' ${GATE_VOCABULARY[name]}`)
    .join("; ");
  return (
    "A JSON object. Its keys: " +
    `'pattern', exactly ${pattern}; ` +
    `'event', exactly one of: ${events}; ` +
    `'matcher', only meaningful for PreToolUse and PostToolUse, one of: ${matchers}; omit the key entirely to match every tool; ` +
    "'gate', an object holding exactly ONE predicate, named only from this " +
    `closed vocabulary and never invented or substituted: ${vocab}. ` +
    "No predicate can read your own reply, so gate on the tool call that comes " +
    "before the mistake, not on the sentence that states it. The gate must be " +
    "narrow: one that fires on every tool call is a broadcast and is refused. " +
    "'once_per', either 'session' or 'always'; " +
    "'text', the nudge shown to the agent: imperative, specific, under 400 " +
    "characters, naming the actual commands or checks the lessons name."
  );
}

export const SHAPES: Record<string, (pattern: string) => string> = {
  skill: skillShape,
  agent: agentShape,
  rule: ruleShape,
  hook: hookShape,
};

export const FORCED_SUBJECT: Record<string, string> = {
  skill: "Claude Code SKILL.md",
  agent: "Claude Code sub-agent definition",
  rule: "one-line rule bullet",
  hook: "Claude Code hook nudge (a JSON object)",
};

const ROUTING_FIELDS =
  'trigger_event is "none", or "<HookEventName>:<Matcher>" (for example ' +
  '"PreToolUse:Bash") naming a real Claude Code hook event this lesson could ' +
  "be checked against mechanically on every matching tool call. gate is a " +
  "single-predicate object usable by the nudge dispatcher, or null if no gate " +
  "applies. needs_own_context is true only if acting on this lesson needs its " +
  "own agent and budget rather than a reminder: the lessons describe an " +
  "investigation that reads many files, logs or tool outputs and reports " +
  "back, or work that would consume the main context's budget. When it is true " +
  "context_evidence MUST be an exact substring copied verbatim from the lessons " +
  `below that shows that need, at least ${MIN_QUOTE_WORDS} words and ` +
  `${MIN_QUOTE_CHARS} characters long, starting and ending at a word boundary. ` +
  `It must carry at least ${MIN_QUOTE_TERMS} words specific to this lesson: a date, a ` +
  "Pattern line or a section heading is not a quote. Without that quote the lesson is treated as a " +
  "discipline rather than an agent. capability_evidence, if set, MUST be an " +
  "exact substring copied verbatim from the lessons below, never paraphrased, " +
  "under the same length rule, naming a concrete thing the agent can actually " +
  "do that neither a hook nor a rule can express: a procedure of several " +
  "ordered commands or checks that does not fit one 300-character bullet. " +
  "Quote the passage that names those steps. no_artifact is true only if no " +
  "artifact at all is warranted.";

export const DRAFTER_SYSTEM =
  "You write Claude Code artifacts from recurring lessons. You reply with one " +
  "JSON object and nothing else: no prose, no code fence, no <think> block.";

export const JUDGE_SYSTEM =
  "You are the last gate before an artifact is committed and starts changing an " +
  "agent's behaviour. You reply with one JSON object and nothing else.";

/** Messages for the drafter.
 *
 * `artifactType` forces a shape (a served_by refine); null lets the reply
 * decide. The two are exclusive on purpose: a routing decision is requested if
 * and only if the caller will route from it. Asking for one and ignoring it is
 * how the body and the route came to disagree in V1. */
export function draftMessages(
  pattern: string,
  lessons: string[],
  existing: string | null = null,
  artifactType: string | null = null,
): ChatMessage[] {
  const sources = boundedSources(lessons);
  const tail = existing ? `\n\nExisting artifact to refine:\n${existing}` : "";
  let user: string;
  if (artifactType !== null && artifactType in SHAPES) {
    user =
      `${existing ? "Refine the existing" : "Write a"} ` +
      `${FORCED_SUBJECT[artifactType]} for the recurring lesson ` +
      `'${pattern}'. Its type is already decided; do not re-decide it.\n\n` +
      'Reply with a JSON object holding exactly one key, "artifact". Its ' +
      `value is ${artifactType === "hook" ? "an object" : "a string"} in this shape:\n` +
      SHAPES[artifactType]!(pattern) +
      "\n\nDo not restate this task, do not add commentary, do not leave " +
      "angle-bracket fill-ins, do not include secrets or tokens.\n\n" +
      "Lessons to generalise:\n\n" +
      sources +
      tail;
  } else {
    user =
      "Decide what kind of Claude Code artifact the recurring lesson " +
      `'${pattern}' should become, then write that artifact.\n\n` +
      "Reply with one JSON object with these keys: trigger_event, gate, " +
      "needs_own_context, context_evidence, capability_evidence, no_artifact, " +
      "artifact.\n\n" +
      ROUTING_FIELDS +
      "\n\n" +
      '"artifact" is the body, and WHICH body is decided by the routing ' +
      "fields you just wrote. Work through these in order and write the " +
      "first one that applies, and only that one:\n" +
      "1. no_artifact is true: artifact is the empty string.\n" +
      '2. trigger_event is not "none" and gate is not null: write a HOOK. ' +
      hookShape(pattern) +
      ' Put it in "artifact" as an OBJECT.\n' +
      "3. needs_own_context is true: write an AGENT, as a string. " +
      agentShape(pattern) +
      "\n" +
      "4. capability_evidence is set: write a SKILL, as a string. " +
      skillShape(pattern) +
      "\n" +
      "5. otherwise: write a RULE, as a string. " +
      ruleShape(pattern) +
      "\n\n" +
      "The body MUST be in the shape the type you selected requires; a body " +
      "in the wrong shape is rejected and this lesson is dropped. Do not " +
      "restate this task, do not add commentary, do not leave angle-bracket " +
      "fill-ins, do not include secrets or tokens.\n\n" +
      "Lessons to generalise:\n\n" +
      sources +
      tail;
  }
  return [
    { role: "system", content: DRAFTER_SYSTEM },
    { role: "user", content: user },
  ];
}

/** Messages for the judge.
 *
 * Adversarial framing, because the permissive version did not discriminate: a
 * small model asked whether a skill "faithfully generalizes its sources"
 * accepted 4 of 5 candidates, including one that inverted its lesson, and
 * justified each by echoing the question's own vocabulary. So enumerate the
 * failure modes, force a quote from the artifact as evidence, and make the
 * verdict the first field.
 *
 * Balanced, not reject-biased. A reject-first wording stopped a 1.7b model
 * rubber-stamping but made a 14b model reject a good draft while its own
 * reasoning said the instruction was supported. Judge the criteria; accept when
 * none are violated. */
export function judgeMessages(pattern: string, artifactType: string, body: string, lessons: string[]): ChatMessage[] {
  const user =
    `Decide strictly but fairly whether this ${artifactType} may be ` +
    `committed for the recurring lesson '${pattern}'. Reject it if it ` +
    "violates any rule below; accept it if it violates none.\n\n" +
    "Reject if ANY of these hold:\n" +
    "1. CONTRADICTS: it advises the opposite of what a source concluded.\n" +
    "2. VAGUE: it is generic advice ('be careful', 'verify things') that " +
    "would not change what someone does. Specific commands or checks must be " +
    "named.\n" +
    "3. UNSUPPORTED: it instructs something no source supports.\n" +
    "4. UNSAFE: it advises skipping a verification a source demands, or " +
    "acting on unverified claims to save time.\n" +
    "5. UNRELATED: its topic is not the sources' topic.\n\n" +
    "Method: quote the artifact's single most important instruction verbatim, " +
    "then name the source sentence that supports it, or state that none does. " +
    "Do not restate this question's wording as your reasoning.\n\n" +
    'Reply with one JSON object: {"verdict": "yes" or "no", ' +
    '"reason": one sentence holding that quote and its supporting source, ' +
    "or the rule number violated}.\n\n" +
    `ARTIFACT:\n${body}\n\nSOURCES:\n${boundedSources(lessons)}`;
  return [
    { role: "system", content: JUDGE_SYSTEM },
    { role: "user", content: user },
  ];
}

// --- reply parsing -----------------------------------------------------------

/** The reply as an object, tolerating a fence or a leading think block.
 *
 * jsonMode is a request, not a guarantee: a model may still wrap the object. */
function loads(raw: string): Record<string, unknown> | null {
  let cleaned = (raw ?? "").replace(THINK_RE, "").trim();
  const fenced = FENCE_RE.exec(cleaned);
  if (fenced) cleaned = fenced[1]!.trim();
  if (!cleaned.startsWith("{")) {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start === -1 || end <= start) return null;
    cleaned = cleaned.slice(start, end + 1);
  }
  let data: unknown;
  try {
    data = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, unknown>;
}

export interface ParseDraftOptions {
  forcedType?: string | null;
}

/** [body, RouteAnswer] from the drafter's reply.
 *
 * An unreadable reply carries `parse_error`, never a default RouteAnswer: a
 * default is what a real "no signal, use the conservative fallback" looks like
 * to `route()`, and returning it for "I could not read this" would route a
 * malformed answer straight at the rules file.
 *
 * On the forced path the routing fields are absent by construction. The caller
 * short-circuits `route()` there, so the answer is never read, and it is left
 * without a `parse_error` so nothing reports a decline the drafter never made. */
export function parseDraft(raw: string, opts: ParseDraftOptions = {}): [unknown, RouteAnswer] {
  const forcedType = opts.forcedType ?? null;
  const data = loads(raw);
  if (data === null) {
    const head = (raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 80);
    return [
      "",
      RouteAnswer.parse({
        parse_error: head ? `reply is not a JSON object (starts ${JSON.stringify(head)})` : "the provider returned an empty reply",
      }),
    ];
  }

  const body = data["artifact"] ?? "";
  if (forcedType !== null) return [coerceBody(body, forcedType), emptyAnswer()];

  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    // `parse_error` describes our reading of the reply, so the reply does not
    // get to set it: a model echoing the schema back could otherwise send an
    // operator after a provider that worked perfectly.
    if (k === "artifact" || k === "parse_error") continue;
    fields[k] = v;
  }
  const parsed = RouteAnswer.safeParse(fields);
  if (!parsed.success) {
    return ["", RouteAnswer.parse({ parse_error: "routing fields failed validation: ZodError" })];
  }
  return [coerceBody(body, null), parsed.data];
}

/** An object for a hook, text for every other type.
 *
 * Keyed on the body's own shape when the type is not yet final, because the
 * router can disagree with what the drafter proposed. A hook body is an object;
 * a SKILL.md, an agent definition and a rule bullet never parse as one. */
function coerceBody(body: unknown, forcedType: string | null): unknown {
  if (body !== null && typeof body === "object" && !Array.isArray(body)) return body;
  let cleaned = String(body ?? "").replace(THINK_RE, "").trim();
  const fenced = FENCE_RE.exec(cleaned);
  if (fenced) cleaned = fenced[1]!.trim();
  if (forcedType === "hook" || (forcedType === null && cleaned.startsWith("{"))) {
    try {
      const parsed: unknown = JSON.parse(cleaned);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // Fall back to the raw string: lint then reports "hook artifact must be a
      // JSON object" and gates the pattern out cleanly, which is the right
      // fail-closed outcome for an unreadable reply.
      return cleaned;
    }
  }
  return cleaned;
}

/** [accepted, reason]. Fails closed, and says so when no verdict was found: an
 * unreadable reply must stay distinguishable from a substantive rejection. */
export function parseVerdict(raw: string): [boolean, string] {
  const data = loads(raw);
  if (data === null) {
    const head = (raw ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 150);
    return [false, head ? `no verdict: unparseable judge reply: ${head}` : "no verdict: empty judge reply"];
  }
  const verdict = String(data["verdict"] ?? "").trim().toLowerCase();
  const reason = String(data["reason"] ?? "").split(/\s+/).filter(Boolean).join(" ").slice(0, 300);
  if (["yes", "true", "accept", "accepted"].includes(verdict)) return [true, reason || "accepted"];
  if (["no", "false", "reject", "rejected"].includes(verdict)) return [false, reason || "rejected"];
  return [false, `no verdict: judge replied ${JSON.stringify(verdict)}`];
}
