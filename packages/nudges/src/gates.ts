// Gate vocabulary and evaluation. Ported from sil/nudge.py's predicate tree.
// evaluate() is total: a malformed gate, a bad regex, or any other error is
// false, never an exception. A gate that threw on the wrong event would take
// the whole dispatcher down for that tool call.

import type { HookEvent } from "@sil/core/consts";

export const MAX_MATCH_LEN = 4000;

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
  if (!(event in EVENTS)) return null;
  const allowed = EVENTS[event]!;
  if (!matcher) return [event as HookEvent, null];
  if (allowed === null || !allowed.has(matcher)) return null;
  return [event as HookEvent, matcher];
}

// Bun/JS has no SIGALRM-style preemption: a catastrophic regex that starts
// running cannot be interrupted mid-evaluation the way sil/nudge.py bounds
// it with an itimer. The defenses here are all static or budget-based
// instead: cap the subject a regex runs against (below), reject the classic
// exponential-backtracking shapes before a gate is ever accepted by lint
// (hasNestedQuantifier, used by validateGate), and cap total wall time
// spent across a nudge list between gates (dispatch.ts). None of these stop
// an already-running catastrophic match on a gate that bypassed lint (a
// hand-placed nudges/*.json file). Out-of-process evaluation under a real
// OS timeout (gate-runner.ts, used by the curriculum drafter) is the only
// mechanism that can actually kill a hung match.
const NESTED_QUANTIFIER_RE = /\([^()]*[+*][^()]*\)[+*]/;

/** True for the classic exponential-backtracking shapes: `(a+)+`, `(.*)*`,
 * `(\w+\s?)+`. A heuristic, not a proof: it looks for a group whose own
 * body already contains a `+`/`*` immediately followed by a `+`/`*` on the
 * group itself. */
export function hasNestedQuantifier(pattern: string): boolean {
  return NESTED_QUANTIFIER_RE.test(pattern);
}

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

/** Translate a shell-style glob (`*`, `?`, `[seq]`, `[!seq]`) to a RegExp,
 * the subset of Python's fnmatch.fnmatch that file_path_matches needs. */
function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      out += ".*";
    } else if (c === "?") {
      out += ".";
    } else if (c === "[") {
      let j = i + 1;
      let cls = "";
      if (glob[j] === "!") {
        cls += "^";
        j++;
      }
      const start = j;
      while (j < glob.length && (j === start || glob[j] !== "]")) j++;
      if (j >= glob.length) {
        out += "\\[";
      } else {
        cls += glob.slice(start, j).replace(/\\/g, "\\\\");
        out += `[${cls}]`;
        i = j;
      }
    } else {
      out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`);
}

function fnmatch(path: string, pattern: string): boolean {
  try {
    return globToRegExp(pattern).test(path);
  } catch {
    return false;
  }
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
      const path = filePath(payload);
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
    if (hasNestedQuantifier(arg)) {
      problems.push(`${label} regex ${JSON.stringify(arg)} has a nested quantifier that can backtrack catastrophically (e.g. (a+)+); rewrite it without a quantified group inside a quantified group`);
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
