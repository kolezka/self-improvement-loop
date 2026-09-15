// Gate vocabulary and evaluation. Ported from sil/nudge.py's predicate tree.
// evaluate() is total: a malformed gate, a bad regex, or any other error is
// false, never an exception. A gate that threw on the wrong event would take
// the whole dispatcher down for that tool call.

import type { HookEvent } from "@sil/core/consts";

export const MAX_MATCH_LEN = 4000;
export const MAX_PATTERN_LEN = 200;
export const MAX_QUANTIFIED_GROUPS = 3;

// Event -> accepted matchers, or null for events that take none. Restricted
// to the events the hook actually delivers additionalContext on: Stop,
// SubagentStop and SessionEnd are not here, so a nudge targeting them is
// rejected by splitTrigger/lintNudge instead of firing for a delivery that
// never happens.
export const EVENTS: Record<string, ReadonlySet<string> | null> = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
  PostToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
};

// Events that fire only a handful of times per session. Everything else
// fires per tool call or per turn: an unconditional gate on it is a
// broadcast, not a nudge. Defined by exclusion: a new event added to EVENTS
// counts as high-frequency until listed here.
export const LOW_FREQUENCY_EVENTS: ReadonlySet<string> = new Set(["SessionStart"]);

export const PREDICATES: ReadonlySet<string> = new Set([
  "always",
  "tool_is",
  "command_matches",
  "file_path_matches",
  "prompt_matches",
  "all",
  "any",
  "not",
]);

/** `"PreToolUse:Bash"` -> `["PreToolUse", "Bash"]`. null if unsupported. */
export function splitTrigger(trigger: string): [HookEvent, string | null] | null {
  const idx = trigger.indexOf(":");
  const event = idx === -1 ? trigger : trigger.slice(0, idx);
  const matcher = idx === -1 ? null : trigger.slice(idx + 1);
  // hasOwn, not `in`: `in` walks the prototype chain, so a trigger named
  // "toString" or "constructor" would pass here and then hand a function to
  // the matcher check below.
  if (!Object.hasOwn(EVENTS, event)) return null;
  const allowed = EVENTS[event]!;
  if (!matcher) return [event as HookEvent, null];
  if (allowed === null || !allowed.has(matcher)) return null;
  return [event as HookEvent, matcher];
}

// Bun/JS has no SIGALRM-style preemption: a catastrophic regex that starts
// running cannot be interrupted mid-evaluation the way sil/nudge.py bounds
// it with an itimer. Three defences stand in for it, and this is exactly
// what each one covers:
//
//  1. Subject cap. Every regex and every glob sees at most MAX_MATCH_LEN
//     characters of the command, prompt or file path it is matched against.
//     Bounds the input, not the pattern.
//  2. Pattern rejection before evaluation. isUnsafeRegex (through
//     validateGate, through lintNudge) refuses the exponential-backtracking
//     shapes, over-long patterns and too many quantified groups, and
//     dispatch.ts lints every nudge file at load so a rejected one is never
//     evaluated. file_path_matches runs no regex at all: fnmatch below is a
//     linear two-pointer matcher.
//  3. List budget. dispatch.ts stops scanning once the whole nudge list has
//     spent its wall-clock budget, and logs a gate_overrun breadcrumb when a
//     single gate runs past gateTimeoutMs. It measures overruns, it cannot
//     cut one short.
//
// What none of them cover: a single pathological gate inside a lint-clean
// pattern. Once it starts it is bounded only by JavaScriptCore's own
// backtracking cap. Out-of-process evaluation under a real OS timeout
// (gate-runner.ts, used by the curriculum drafter) is still the only
// mechanism that can actually kill a hung match.

// A quantifier on a group is dangerous when the group body can itself match
// the same text more than one way: another quantifier, an alternation, or an
// optional inside it.
const RISKY_GROUP_BODY = /[|+*?{]/;
const BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;

/** Bodies of every group carrying a `+`, `*` or `{n,}` quantifier. Skips
 * escapes and character classes so `\(` and `[(]` are not read as groups. */
function quantifiedGroupBodies(pattern: string): string[] {
  const bodies: string[] = [];
  const open: number[] = [];
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]") inClass = false;
      continue;
    }
    if (c === "[") {
      inClass = true;
      continue;
    }
    if (c === "(") {
      open.push(i);
      continue;
    }
    if (c !== ")") continue;
    const start = open.pop();
    if (start === undefined) continue;
    const next = pattern[i + 1];
    const quantified = next === "+" || next === "*" || (next === "{" && BRACE_QUANTIFIER.test(pattern.slice(i + 1)));
    if (quantified) bodies.push(pattern.slice(start + 1, i));
  }
  return bodies;
}

/** Why `pattern` is refused, or null when it is acceptable. A heuristic, not
 * a proof: it rejects shapes that are known to backtrack exponentially, plus
 * two size limits that keep the search space small even for a shape it does
 * not recognise. */
export function unsafeRegexReason(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_LEN) {
    return `is ${pattern.length} chars; the cap is ${MAX_PATTERN_LEN}`;
  }
  const bodies = quantifiedGroupBodies(pattern);
  if (bodies.length > MAX_QUANTIFIED_GROUPS) {
    return `has ${bodies.length} quantified groups; the cap is ${MAX_QUANTIFIED_GROUPS}`;
  }
  const risky = bodies.find((b) => RISKY_GROUP_BODY.test(b));
  if (risky !== undefined) {
    return (
      `has a quantified group ${JSON.stringify(`(${risky})`)} that can backtrack ` +
      `catastrophically (e.g. (a+)+, (a|aa)+); rewrite it without a quantifier, ` +
      `alternation or optional inside a quantified group`
    );
  }
  return null;
}

/** True for a pattern validateGate must refuse. */
export function isUnsafeRegex(pattern: string): boolean {
  return unsafeRegexReason(pattern) !== null;
}

/** Former name of isUnsafeRegex, kept so existing callers keep compiling. */
export const hasNestedQuantifier = isUnsafeRegex;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function command(payload: Record<string, unknown>): string {
  const ti = payload["tool_input"];
  return isRecord(ti) && typeof ti["command"] === "string" ? ti["command"] : "";
}

function filePath(payload: Record<string, unknown>): string {
  const ti = payload["tool_input"];
  return isRecord(ti) && typeof ti["file_path"] === "string" ? ti["file_path"] : "";
}

interface ClassMatch {
  end: number;
  matched: boolean;
}

/** Parse the `[...]` class starting at `start` and say whether `ch` is in
 * it. null when the class is unterminated, which fnmatch treats as a literal
 * `[`. A `]` in first position is a literal `]`, and `!`/`^` in first
 * position negate. */
function matchClass(pattern: string, start: number, ch: string): ClassMatch | null {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  const first = i;
  let matched = false;
  while (i < pattern.length) {
    if (pattern[i] === "]" && i > first) break;
    if (pattern[i + 1] === "-" && i + 2 < pattern.length && pattern[i + 2] !== "]") {
      if (ch >= pattern[i]! && ch <= pattern[i + 2]!) matched = true;
      i += 3;
      continue;
    }
    if (pattern[i] === ch) matched = true;
    i++;
  }
  if (i >= pattern.length) return null;
  return { end: i + 1, matched: negate ? !matched : matched };
}

/** Shell-style glob match (`*`, `?`, `[seq]`, `[!seq]`), the subset of
 * Python's fnmatch that file_path_matches needs.
 *
 * Two pointers with a single remembered `*` position, so the work is bounded
 * by path length times pattern length. The regex translation this replaced
 * turned every `*` into `.*`, which made `*a*a*a*a*b` against a long path
 * take minutes: JS has no atomic groups to stop the engine re-splitting the
 * same text across the stars. */
function fnmatch(path: string, pattern: string): boolean {
  let si = 0;
  let pi = 0;
  let starSi = -1;
  let starPi = -1;

  while (si < path.length) {
    const pc: string | undefined = pattern[pi];
    if (pc === "*") {
      starPi = pi;
      starSi = si;
      pi++;
      continue;
    }

    let ok = false;
    if (pc === "?") {
      ok = true;
      pi++;
    } else if (pc === "[") {
      const cls = matchClass(pattern, pi, path[si]!);
      if (cls === null) {
        ok = path[si] === "[";
        pi++;
      } else {
        ok = cls.matched;
        pi = cls.end;
      }
    } else if (pc !== undefined && pc === path[si]) {
      ok = true;
      pi++;
    }

    if (ok) {
      si++;
      continue;
    }
    // Backtrack: let the last `*` swallow one more character. Each retry
    // starts one character further along, so the loop is linear in the path.
    if (starPi === -1) return false;
    starSi++;
    si = starSi;
    pi = starPi + 1;
  }

  while (pattern[pi] === "*") pi++;
  return pi === pattern.length;
}

/** re.search equivalent, bounded: the matched text is capped so a
 * pathological pattern on a huge string cannot blow up evaluate() called
 * outside a wall-clock deadline. */
function search(pattern: unknown, text: string): boolean {
  if (typeof pattern !== "string") return false;
  try {
    return new RegExp(pattern).test(text.slice(0, MAX_MATCH_LEN));
  } catch {
    return false;
  }
}

function evaluateInner(gate: unknown, payload: Record<string, unknown>): boolean {
  if (!isRecord(gate)) return false;
  const keys = Object.keys(gate);
  if (keys.length !== 1) return false;
  const name = keys[0]!;
  const arg = gate[name];
  switch (name) {
    case "always":
      return true;
    case "tool_is":
      return Array.isArray(arg) && arg.includes(payload["tool_name"]);
    case "command_matches":
      return search(arg, command(payload));
    case "file_path_matches": {
      if (typeof arg !== "string") return false;
      // Same cap as search(): a glob is linear now, but linear in a 10 MB
      // file_path is still work the hook does not need to do.
      const path = filePath(payload).slice(0, MAX_MATCH_LEN);
      return path !== "" && fnmatch(path, arg);
    }
    case "prompt_matches":
      return search(arg, typeof payload["prompt"] === "string" ? payload["prompt"] : "");
    case "all":
      return Array.isArray(arg) && arg.every((g) => evaluateInner(g, payload));
    case "any":
      return Array.isArray(arg) && arg.some((g) => evaluateInner(g, payload));
    case "not":
      return !evaluateInner(arg, payload);
    default:
      return false;
  }
}

export function evaluate(gate: unknown, payload: Record<string, unknown>): boolean {
  try {
    return evaluateInner(gate, payload);
  } catch {
    return false;
  }
}

/** Structurally validate every node, unlike evaluate()'s execution probe:
 * evaluate() short-circuits through all()/any(), so a payload that fails
 * clause 1 never touches clause 2's regex. A walker that recurses
 * unconditionally is the only thing that sees the whole tree. */
export function validateGate(gate: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(gate)) {
    problems.push(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
    return problems;
  }
  const keys = Object.keys(gate);
  if (keys.length !== 1) {
    problems.push(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
    return problems;
  }
  const name = keys[0]!;
  const arg = gate[name];
  if (!PREDICATES.has(name)) {
    problems.push(`unknown predicate ${JSON.stringify(name)}; allowed: ${[...PREDICATES].sort().join(", ")}`);
    return problems;
  }

  const checkRegex = (label: string): void => {
    if (typeof arg !== "string") {
      problems.push(`${label} takes a regex string`);
      return;
    }
    try {
      new RegExp(arg);
    } catch (e) {
      problems.push(`${label} has bad regex ${JSON.stringify(arg)}: ${(e as Error).message}`);
      return;
    }
    const reason = unsafeRegexReason(arg);
    if (reason !== null) {
      problems.push(`${label} regex ${JSON.stringify(arg.slice(0, MAX_PATTERN_LEN))} ${reason}`);
    }
  };

  switch (name) {
    case "always":
      break;
    case "tool_is":
      if (!Array.isArray(arg)) problems.push("tool_is takes a list of tool names");
      break;
    case "command_matches":
      checkRegex("command_matches");
      break;
    case "file_path_matches":
      if (typeof arg !== "string") problems.push("file_path_matches takes a glob string");
      else if (arg.length > MAX_PATTERN_LEN) problems.push(`file_path_matches glob is ${arg.length} chars; the cap is ${MAX_PATTERN_LEN}`);
      break;
    case "prompt_matches":
      checkRegex("prompt_matches");
      break;
    case "all":
    case "any":
      if (!Array.isArray(arg)) {
        problems.push(`${name} takes a list of predicates`);
      } else {
        for (const child of arg) problems.push(...validateGate(child));
      }
      break;
    case "not":
      problems.push(...validateGate(arg));
      break;
  }
  return problems;
}

/** Static truth of a whole gate tree: true (fires for every payload), false
 * (fires for none), null (payload-dependent, the normal answer). Malformed
 * input is null, never an exception. */
export function gateTruth(gate: unknown): boolean | null {
  if (!isRecord(gate)) return null;
  const keys = Object.keys(gate);
  if (keys.length !== 1) return null;
  const name = keys[0]!;
  const arg = gate[name];
  switch (name) {
    case "always":
      return true;
    case "tool_is":
      return Array.isArray(arg) && arg.length === 0 ? false : null;
    case "command_matches":
    case "prompt_matches":
      // re.search("", s) matches at position 0 of every string, including
      // the "" these predicates yield on a payload with no command/prompt.
      return arg === "" ? true : null;
    case "all": {
      if (!Array.isArray(arg)) return null;
      const truths = arg.map(gateTruth);
      if (truths.some((t) => t === false)) return false;
      return truths.every((t) => t === true) ? true : null;
    }
    case "any": {
      if (!Array.isArray(arg)) return null;
      const truths = arg.map(gateTruth);
      if (truths.some((t) => t === true)) return true;
      return truths.every((t) => t === false) ? false : null;
    }
    case "not": {
      const inner = gateTruth(arg);
      return inner === null ? null : !inner;
    }
    default:
      return null;
  }
}
