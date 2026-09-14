// @bun
// packages/nudges/src/gate-runner.ts
import { existsSync as existsSync2 } from "fs";
import { join as join2 } from "path";

// packages/core/src/paths.ts
import { existsSync } from "fs";
import { dirname, join, resolve } from "path";
var manifestRoot;
function findManifestRoot(start) {
  let dir = resolve(start);
  for (;; ) {
    if (existsSync(join(dir, ".claude-plugin", "plugin.json")))
      return dir;
    const parent = dirname(dir);
    if (parent === dir)
      return null;
    dir = parent;
  }
}
function pluginRoot() {
  const raw = process.env["CLAUDE_PLUGIN_ROOT"];
  if (raw)
    return raw;
  if (manifestRoot === undefined)
    manifestRoot = findManifestRoot(import.meta.dir);
  return manifestRoot ?? resolve(import.meta.dir, "..", "..", "..");
}

// packages/nudges/src/gates.ts
var MAX_MATCH_LEN = 4000;
var EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
  PostToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"])
};
var LOW_FREQUENCY_EVENTS = new Set(["SessionStart"]);
var PREDICATES = new Set([
  "always",
  "tool_is",
  "command_matches",
  "file_path_matches",
  "prompt_matches",
  "all",
  "any",
  "not"
]);
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function command(payload) {
  const ti = payload["tool_input"];
  return isRecord(ti) && typeof ti["command"] === "string" ? ti["command"] : "";
}
function filePath(payload) {
  const ti = payload["tool_input"];
  return isRecord(ti) && typeof ti["file_path"] === "string" ? ti["file_path"] : "";
}
function matchClass(pattern, start, ch) {
  let i = start + 1;
  let negate = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negate = true;
    i++;
  }
  const first = i;
  let matched = false;
  while (i < pattern.length) {
    if (pattern[i] === "]" && i > first)
      break;
    if (pattern[i + 1] === "-" && i + 2 < pattern.length && pattern[i + 2] !== "]") {
      if (ch >= pattern[i] && ch <= pattern[i + 2])
        matched = true;
      i += 3;
      continue;
    }
    if (pattern[i] === ch)
      matched = true;
    i++;
  }
  if (i >= pattern.length)
    return null;
  return { end: i + 1, matched: negate ? !matched : matched };
}
function fnmatch(path, pattern) {
  let si = 0;
  let pi = 0;
  let starSi = -1;
  let starPi = -1;
  while (si < path.length) {
    const pc = pattern[pi];
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
      const cls = matchClass(pattern, pi, path[si]);
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
    if (starPi === -1)
      return false;
    starSi++;
    si = starSi;
    pi = starPi + 1;
  }
  while (pattern[pi] === "*")
    pi++;
  return pi === pattern.length;
}
function search(pattern, text) {
  if (typeof pattern !== "string")
    return false;
  try {
    return new RegExp(pattern).test(text.slice(0, MAX_MATCH_LEN));
  } catch {
    return false;
  }
}
function evaluateInner(gate, payload) {
  if (!isRecord(gate))
    return false;
  const keys = Object.keys(gate);
  if (keys.length !== 1)
    return false;
  const name = keys[0];
  const arg = gate[name];
  switch (name) {
    case "always":
      return true;
    case "tool_is":
      return Array.isArray(arg) && arg.includes(payload["tool_name"]);
    case "command_matches":
      return search(arg, command(payload));
    case "file_path_matches": {
      if (typeof arg !== "string")
        return false;
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
function evaluate(gate, payload) {
  try {
    return evaluateInner(gate, payload);
  } catch {
    return false;
  }
}

// packages/nudges/src/gate-runner.ts
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
async function runFromStdin() {
  try {
    const raw = await Bun.stdin.text();
    const input = JSON.parse(raw);
    if (!isRecord2(input) || !Array.isArray(input["payloads"])) {
      throw new Error("expected {gate, payloads: [...]}");
    }
    const gate = input["gate"];
    const results = input["payloads"].map((p) => evaluate(gate, isRecord2(p) ? p : {}));
    console.log(JSON.stringify({ results }));
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
  }
}
function resolveRunner() {
  const built = join2(pluginRoot(), "dist", "gate-runner.js");
  if (existsSync2(built))
    return built;
  return join2(pluginRoot(), "packages", "nudges", "src", "gate-runner.ts");
}
function runGateCorpus(gate, payloads, timeoutMs = 250) {
  const runner = resolveRunner();
  const input = JSON.stringify({ gate, payloads });
  let proc;
  try {
    proc = Bun.spawnSync(["bun", runner], { stdin: Buffer.from(input, "utf8"), stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
  } catch (e) {
    return { results: null, error: e.message, timedOut: false };
  }
  if (proc.exitCode === null) {
    return { results: null, error: `gate corpus evaluation exceeded ${timeoutMs}ms`, timedOut: true };
  }
  const out = (proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim();
  try {
    const parsed = JSON.parse(out);
    if (isRecord2(parsed) && typeof parsed["error"] === "string") {
      return { results: null, error: parsed["error"], timedOut: false };
    }
    if (isRecord2(parsed) && Array.isArray(parsed["results"])) {
      return { results: parsed["results"], error: null, timedOut: false };
    }
    return { results: null, error: `unexpected gate-runner output: ${out.slice(0, 200)}`, timedOut: false };
  } catch {
    return { results: null, error: `unparseable gate-runner output: ${out.slice(0, 200)}`, timedOut: false };
  }
}
if (import.meta.main) {
  await runFromStdin();
}
export {
  runGateCorpus
};
