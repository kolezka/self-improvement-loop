// @bun
// packages/nudges/src/gate-runner.ts
import { existsSync } from "fs";
import { join as join2 } from "path";

// packages/core/src/paths.ts
import { join, resolve } from "path";
function pluginRoot() {
  const raw = process.env["CLAUDE_PLUGIN_ROOT"];
  if (raw)
    return raw;
  return resolve(import.meta.dir, "..", "..", "..");
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
function globToRegExp(glob) {
  let out = "";
  for (let i = 0;i < glob.length; i++) {
    const c = glob[i];
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
      while (j < glob.length && (j === start || glob[j] !== "]"))
        j++;
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
function fnmatch(path, pattern) {
  try {
    return globToRegExp(pattern).test(path);
  } catch {
    return false;
  }
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
  if (existsSync(built))
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
