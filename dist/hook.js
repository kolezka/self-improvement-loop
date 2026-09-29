// @bun
var __defProp = Object.defineProperty;
var __returnValue = (v) => v;
function __exportSetter(name, newValue) {
  this[name] = __returnValue.bind(null, newValue);
}
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, {
      get: all[name],
      enumerable: true,
      configurable: true,
      set: __exportSetter.bind(all, name)
    });
};
var __esm = (fn, res, err) => () => {
  if (fn)
    try {
      res = fn(fn = 0);
    } catch (e) {
      err = [e];
    }
  if (err)
    throw err[0];
  return res;
};
var __promiseAll = (args) => Promise.all(args);

// packages/core/src/layout.ts
function normalize(p) {
  const absolute = p.charCodeAt(0) === SLASH;
  const trailingSlash = p.length > 1 && p.charCodeAt(p.length - 1) === SLASH;
  const out = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".")
      continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..")
        out.pop();
      else if (!absolute)
        out.push("..");
      continue;
    }
    out.push(segment);
  }
  let joined = out.join("/");
  if (absolute)
    joined = `/${joined}`;
  else if (joined === "")
    joined = ".";
  if (trailingSlash && joined !== "/")
    joined += "/";
  return joined;
}
function posixJoin(...parts) {
  let joined = "";
  for (const part of parts) {
    if (part.length === 0)
      continue;
    joined = joined.length === 0 ? part : `${joined}/${part}`;
  }
  return joined.length === 0 ? "." : normalize(joined);
}
function isWithin(child, parent) {
  if (child === parent)
    return true;
  if (parent === "/")
    return true;
  return child.startsWith(`${parent}/`);
}
function expandHomeWith(p, home) {
  if (p === "~")
    return home;
  if (p.startsWith("~/"))
    return posixJoin(home, p.slice(2));
  return p;
}
function safeComponent(name) {
  const cleaned = Array.from(name.normalize("NFC"), (c) => SAFE_CHAR.test(c) ? c : "_").join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}
function envPath(env, name, fallback) {
  const raw = env.get(name);
  return raw && raw.length > 0 ? expandHomeWith(raw, env.home) : fallback;
}
function layout(env) {
  const configDir = () => envPath(env, "SIL_CONFIG_DIR", posixJoin(envPath(env, "XDG_CONFIG_HOME", posixJoin(env.home, ".config")), "self-improvement-loop"));
  const stateDir = () => envPath(env, "SIL_STATE_DIR", posixJoin(envPath(env, "XDG_STATE_HOME", posixJoin(env.home, ".local", "state")), "self-improvement-loop"));
  const dataDir = () => envPath(env, "SIL_DATA_DIR", posixJoin(envPath(env, "XDG_DATA_HOME", posixJoin(env.home, ".local", "share")), "self-improvement-loop"));
  const worldDir = (world) => posixJoin(dataDir(), "worlds", safeComponent(world));
  return {
    configDir,
    stateDir,
    dataDir,
    worldDir,
    queueDir: (bucket) => posixJoin(stateDir(), "queue", bucket),
    usageEventsFile: () => posixJoin(stateDir(), "usage", "events.jsonl"),
    hookRunsFile: () => posixJoin(stateDir(), "usage", "hook-runs.jsonl"),
    payloadSamplesFile: (world) => posixJoin(stateDir(), "usage", "payloads", `${safeComponent(world)}.jsonl`),
    nudgeFiresFile: () => posixJoin(stateDir(), "usage", "nudge-fires.jsonl"),
    inboxDir: (world) => posixJoin(stateDir(), "inbox", safeComponent(world)),
    sessionDir: (sessionId) => posixJoin(stateDir(), "sessions", safeComponent(sessionId)),
    workerLockFile: () => posixJoin(stateDir(), "worker.lock"),
    hookSnapshotFile: () => posixJoin(stateDir(), "hook-config.json"),
    logFile: (name) => posixJoin(stateDir(), "logs", `${safeComponent(name)}.log`),
    defaultTarget: (world) => posixJoin(worldDir(world), "learned")
  };
}
var SLASH = 47, SAFE_CHAR;
var init_layout = __esm(() => {
  SAFE_CHAR = /[\p{L}\p{N}._-]/u;
});

// packages/core/src/paths.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
function current() {
  return layout({ get: (name) => process.env[name], home: homedir() });
}
function stateDir() {
  return current().stateDir();
}
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
var manifestRoot, queueDir = (bucket) => current().queueDir(bucket), usageEventsFile = () => current().usageEventsFile(), hookRunsFile = () => current().hookRunsFile(), payloadSamplesFile = (world) => current().payloadSamplesFile(world), nudgeFiresFile = () => current().nudgeFiresFile(), inboxDir = (world) => current().inboxDir(world), sessionDir = (sessionId) => current().sessionDir(sessionId), workerLockFile = () => current().workerLockFile(), hookSnapshotFile = () => current().hookSnapshotFile(), logFile = (name) => current().logFile(name), defaultTarget = (world) => current().defaultTarget(world), builtinNudgesDir = () => join(pluginRoot(), "nudges");
var init_paths = __esm(() => {
  init_layout();
});

// packages/core/src/fsx.ts
import { appendFileSync, existsSync as existsSync2, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname as dirname2, join as join2 } from "path";
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
function atomicWrite(path, text) {
  ensureDir(dirname2(path));
  const tmp = join2(dirname2(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  writeFileSync(tmp, text, "utf8");
  renameSync(tmp, path);
}
function readJsonOr(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}
function appendLine(path, line, rotateAt = ROTATE_AT_BYTES, keep = ROTATE_KEEP_LINES) {
  ensureDir(dirname2(path));
  try {
    if (statSync(path).size >= rotateAt) {
      const lines = readFileSync(path, "utf8").split(`
`).filter((l) => l.length > 0);
      atomicWrite(path, rotated(lines, rotateAt, keep));
    }
  } catch {}
  appendFileSync(path, line.endsWith(`
`) ? line : line + `
`, "utf8");
}
function rotated(lines, rotateAt, keep) {
  const kept = lines.slice(-keep);
  let size = kept.reduce((n, l) => n + Buffer.byteLength(l, "utf8") + 1, 0);
  let start = 0;
  while (start < kept.length - 1 && size > rotateAt / 2) {
    size -= Buffer.byteLength(kept[start], "utf8") + 1;
    start += 1;
  }
  return kept.slice(start).join(`
`) + `
`;
}
var ROTATE_AT_BYTES, ROTATE_KEEP_LINES = 5000;
var init_fsx = __esm(() => {
  ROTATE_AT_BYTES = 10 * 1024 * 1024;
});

// packages/core/src/samples.ts
function redactCredentials(text) {
  return text.replace(CREDENTIAL_RE, "$1<redacted>");
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function sampleRecord(payload, ts) {
  const toolName = payload["tool_name"];
  if (typeof toolName !== "string" || !toolName)
    return null;
  const rawInput = payload["tool_input"];
  const toolInput = {};
  if (isRecord(rawInput)) {
    for (const key of SAMPLED_INPUT_KEYS) {
      const value = rawInput[key];
      if (typeof value === "string")
        toolInput[key] = redactCredentials(value.slice(0, SAMPLE_VALUE_MAX_CHARS));
    }
  }
  const sessionId = payload["session_id"];
  const eventName = payload["hook_event_name"];
  return {
    ts,
    session_id: typeof sessionId === "string" && sessionId ? sessionId : "unknown",
    hook_event_name: typeof eventName === "string" ? eventName : "",
    tool_name: toolName,
    tool_input: toolInput
  };
}
var SAMPLED_INPUT_KEYS, SAMPLE_VALUE_MAX_CHARS = 500, SAMPLES_ROTATE_AT_BYTES, SAMPLES_KEEP_LINES = 2000, CREDENTIAL_RE;
var init_samples = __esm(() => {
  SAMPLED_INPUT_KEYS = ["command", "file_path"];
  SAMPLES_ROTATE_AT_BYTES = 2 * 1024 * 1024;
  CREDENTIAL_RE = /((?:authorization:\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+|(?:token|api[_-]?key|password|passwd|secret)=)['"]?)[^\s'"]+/gi;
});

// packages/nudges/src/firelog.ts
import { createHash } from "crypto";
import { appendFileSync as appendFileSync2, existsSync as existsSync3, mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync, statSync as statSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname3 } from "path";
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}
function reclaimable(lockDir, staleMs) {
  let raw = null;
  try {
    raw = readFileSync2(`${lockDir}/pid`, "utf8");
  } catch {
    raw = null;
  }
  if (raw !== null) {
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid <= 0)
      return true;
    return !pidAlive(pid);
  }
  try {
    return Date.now() - statSync2(lockDir).mtimeMs > staleMs;
  } catch {
    return false;
  }
}
function withDirLock(lockDir, fn, staleMs = DEFAULT_STALE_MS) {
  const giveUpAt = Date.now() + Math.max(staleMs, MIN_WAIT_MS);
  for (;; ) {
    let held = false;
    try {
      mkdirSync2(lockDir);
      held = true;
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
    }
    if (held) {
      try {
        writeFileSync2(`${lockDir}/pid`, `${process.pid}
`, "utf8");
      } catch {}
      break;
    }
    if (reclaimable(lockDir, staleMs)) {
      try {
        rmSync(lockDir, { recursive: true, force: true });
      } catch {}
    }
    if (Date.now() > giveUpAt)
      throw new Error(`withDirLock: timed out waiting for ${lockDir}`);
    Bun.sleepSync(5);
  }
  try {
    return fn();
  } finally {
    rmSync(lockDir, { recursive: true, force: true });
  }
}
function rotateIfNeeded(path, rotateAt, keep) {
  let size;
  try {
    size = statSync2(path).size;
  } catch {
    return;
  }
  if (size < rotateAt)
    return;
  const lines = readFileSync2(path, "utf8").split(`
`).filter((l) => l.length > 0);
  atomicWrite(path, lines.slice(-keep).join(`
`) + `
`);
}
function appendLine2(path, line, rotateAt = ROTATE_AT_BYTES2, keep = ROTATE_KEEP_LINES2) {
  try {
    mkdirSync2(dirname3(path), { recursive: true });
    withDirLock(`${path}.lockdir`, () => {
      rotateIfNeeded(path, rotateAt, keep);
      appendFileSync2(path, line.endsWith(`
`) ? line : `${line}
`, "utf8");
    });
  } catch {}
}
function markerSlug(raw) {
  const safe = raw.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
  const digest = createHash("sha256").update(raw, "utf8").digest("hex").slice(0, 8);
  return `${safe}-${digest}`;
}
function claimMarker(sessionDir, name) {
  try {
    const markers = `${sessionDir}/nudge-markers`;
    mkdirSync2(markers, { recursive: true });
    const mark = `${markers}/${markerSlug(name)}`;
    if (existsSync3(mark))
      return false;
    writeFileSync2(mark, "", { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
function ts() {
  return new Date().toISOString();
}
function writeBreadcrumb(fireLog, sessionDir, kind, sessionId, event, extra = {}, dedupeKey) {
  if (!claimMarker(sessionDir, `breadcrumb-${dedupeKey ?? `${kind}-${event}`}`))
    return;
  const record = { ts: ts(), kind, session_id: sessionId, event, ...extra };
  appendLine2(fireLog, JSON.stringify(record));
}
var ROTATE_AT_BYTES2, ROTATE_KEEP_LINES2 = 5000, DEFAULT_STALE_MS = 2000, MIN_WAIT_MS = 200;
var init_firelog = __esm(() => {
  init_fsx();
  ROTATE_AT_BYTES2 = 10 * 1024 * 1024;
});

// packages/nudges/src/gates.ts
function splitTrigger(trigger) {
  const idx = trigger.indexOf(":");
  const event = idx === -1 ? trigger : trigger.slice(0, idx);
  const matcher = idx === -1 ? null : trigger.slice(idx + 1);
  if (!Object.hasOwn(EVENTS, event))
    return null;
  const allowed = EVENTS[event];
  if (!matcher)
    return [event, null];
  if (allowed === null || !allowed.has(matcher))
    return null;
  return [event, matcher];
}
function quantifiedGroupBodies(pattern) {
  const bodies = [];
  const open = [];
  let inClass = false;
  for (let i = 0;i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (inClass) {
      if (c === "]")
        inClass = false;
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
    if (c !== ")")
      continue;
    const start = open.pop();
    if (start === undefined)
      continue;
    const next = pattern[i + 1];
    const quantified = next === "+" || next === "*" || next === "{" && BRACE_QUANTIFIER.test(pattern.slice(i + 1));
    if (quantified)
      bodies.push(pattern.slice(start + 1, i));
  }
  return bodies;
}
function unsafeRegexReason(pattern) {
  if (pattern.length > MAX_PATTERN_LEN) {
    return `is ${pattern.length} chars; the cap is ${MAX_PATTERN_LEN}`;
  }
  const bodies = quantifiedGroupBodies(pattern);
  if (bodies.length > MAX_QUANTIFIED_GROUPS) {
    return `has ${bodies.length} quantified groups; the cap is ${MAX_QUANTIFIED_GROUPS}`;
  }
  const risky = bodies.find((b) => RISKY_GROUP_BODY.test(b));
  if (risky !== undefined) {
    return `has a quantified group ${JSON.stringify(`(${risky})`)} that can backtrack ` + `catastrophically (e.g. (a+)+, (a|aa)+); rewrite it without a quantifier, ` + `alternation or optional inside a quantified group`;
  }
  return null;
}
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function command(payload) {
  const ti = payload["tool_input"];
  return isRecord2(ti) && typeof ti["command"] === "string" ? ti["command"] : "";
}
function filePath(payload) {
  const ti = payload["tool_input"];
  return isRecord2(ti) && typeof ti["file_path"] === "string" ? ti["file_path"] : "";
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
  if (!isRecord2(gate))
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
function validateGate(gate) {
  const problems = [];
  if (!isRecord2(gate)) {
    problems.push(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
    return problems;
  }
  const keys = Object.keys(gate);
  if (keys.length !== 1) {
    problems.push(`a gate is exactly one predicate, got: ${JSON.stringify(gate)}`);
    return problems;
  }
  const name = keys[0];
  const arg = gate[name];
  if (!PREDICATES.has(name)) {
    problems.push(`unknown predicate ${JSON.stringify(name)}; allowed: ${[...PREDICATES].sort().join(", ")}`);
    return problems;
  }
  const checkRegex = (label) => {
    if (typeof arg !== "string") {
      problems.push(`${label} takes a regex string`);
      return;
    }
    try {
      new RegExp(arg);
    } catch (e) {
      problems.push(`${label} has bad regex ${JSON.stringify(arg)}: ${e.message}`);
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
      if (!Array.isArray(arg))
        problems.push("tool_is takes a list of tool names");
      break;
    case "command_matches":
      checkRegex("command_matches");
      break;
    case "file_path_matches":
      if (typeof arg !== "string")
        problems.push("file_path_matches takes a glob string");
      else if (arg.length > MAX_PATTERN_LEN)
        problems.push(`file_path_matches glob is ${arg.length} chars; the cap is ${MAX_PATTERN_LEN}`);
      break;
    case "prompt_matches":
      checkRegex("prompt_matches");
      break;
    case "all":
    case "any":
      if (!Array.isArray(arg)) {
        problems.push(`${name} takes a list of predicates`);
      } else {
        for (const child of arg)
          problems.push(...validateGate(child));
      }
      break;
    case "not":
      problems.push(...validateGate(arg));
      break;
  }
  return problems;
}
function gateTruth(gate) {
  if (!isRecord2(gate))
    return null;
  const keys = Object.keys(gate);
  if (keys.length !== 1)
    return null;
  const name = keys[0];
  const arg = gate[name];
  switch (name) {
    case "always":
      return true;
    case "tool_is":
      return Array.isArray(arg) && arg.length === 0 ? false : null;
    case "command_matches":
    case "prompt_matches":
      return arg === "" ? true : null;
    case "all": {
      if (!Array.isArray(arg))
        return null;
      const truths = arg.map(gateTruth);
      if (truths.some((t) => t === false))
        return false;
      return truths.every((t) => t === true) ? true : null;
    }
    case "any": {
      if (!Array.isArray(arg))
        return null;
      const truths = arg.map(gateTruth);
      if (truths.some((t) => t === true))
        return true;
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
var MAX_MATCH_LEN = 4000, MAX_PATTERN_LEN = 200, MAX_QUANTIFIED_GROUPS = 3, TOOL_MATCHERS, EVENTS, LOW_FREQUENCY_EVENTS, PREDICATES, RISKY_GROUP_BODY, BRACE_QUANTIFIER;
var init_gates = __esm(() => {
  TOOL_MATCHERS = ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill", "ToolSearch", "WebFetch", "WebSearch", "NotebookEdit"];
  EVENTS = {
    SessionStart: null,
    UserPromptSubmit: null,
    PreToolUse: new Set(TOOL_MATCHERS),
    PostToolUse: new Set(TOOL_MATCHERS)
  };
  LOW_FREQUENCY_EVENTS = new Set(["SessionStart"]);
  PREDICATES = new Set([
    "always",
    "tool_is",
    "command_matches",
    "file_path_matches",
    "prompt_matches",
    "all",
    "any",
    "not"
  ]);
  RISKY_GROUP_BODY = /[|+*?{]/;
  BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;
});

// packages/core/src/consts.ts
var RULE_START = "<!--loop-rules:start-->", RULE_END = "<!--loop-rules:end-->", SLUG_RE, isSlug = (s) => SLUG_RE.test(s) && s.length <= 64;
var init_consts = __esm(() => {
  SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
});

// packages/nudges/src/lint.ts
function unboundedBroadcastRule() {
  const low = [...LOW_FREQUENCY_EVENTS].sort().join(", ");
  return "a gate that is true for every payload is accepted only when " + "something else bounds it: set 'once_per' to 'session', or use " + `one of the low-frequency events (${low}). An unconditional gate ` + "with 'once_per' set to 'always' on any other event is rejected outright";
}
function lintUnboundedBroadcast(obj) {
  if (gateTruth(obj.gate) !== true)
    return [];
  if (obj.once_per === "session")
    return [];
  if (LOW_FREQUENCY_EVENTS.has(obj.event))
    return [];
  return [
    `degenerate gate: it fires unconditionally, once_per is ` + `${JSON.stringify(obj.once_per)}, and ${obj.event} fires many times per ` + `session, this injects on every ${obj.event} forever and ` + `discriminates nothing. Narrow the gate to a real predicate, or ` + unboundedBroadcastRule()
  ];
}
function isRecord3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function lintNudge(obj) {
  if (!isRecord3(obj))
    return ["nudge must be a JSON object"];
  const problems = [];
  for (const field of ["pattern", "event", "gate", "once_per", "text"]) {
    if (!(field in obj))
      problems.push(`missing required field ${JSON.stringify(field)}`);
  }
  if (problems.length > 0)
    return problems;
  if (typeof obj["pattern"] !== "string")
    problems.push("field 'pattern' must be a string");
  else if (!isSlug(obj["pattern"]))
    problems.push(`field 'pattern' must be a slug, got ${JSON.stringify(obj["pattern"])}`);
  if (typeof obj["event"] !== "string")
    problems.push("field 'event' must be a string");
  if (!isRecord3(obj["gate"]))
    problems.push("field 'gate' must be a dict");
  if (typeof obj["once_per"] !== "string")
    problems.push("field 'once_per' must be a string");
  if (typeof obj["text"] !== "string")
    problems.push("field 'text' must be a string");
  if (obj["matcher"] !== undefined && obj["matcher"] !== null && typeof obj["matcher"] !== "string") {
    problems.push("field 'matcher' must be a string or absent");
  }
  if (problems.length > 0)
    return problems;
  const event = obj["event"];
  const matcher = obj["matcher"];
  const text = obj["text"];
  const oncePer = obj["once_per"];
  const trigger = event + (matcher ? `:${matcher}` : "");
  const triggerOk = splitTrigger(trigger) !== null;
  if (!triggerOk)
    problems.push(`unsupported event/matcher: ${JSON.stringify(trigger)}`);
  const oncePerOk = ONCE_PER.has(oncePer);
  if (!oncePerOk)
    problems.push(`once_per must be one of ${[...ONCE_PER].sort().join(", ")}`);
  if (!text.trim())
    problems.push("text must be a non-empty string");
  else if (text.length > MAX_TEXT)
    problems.push(`text is ${text.length} chars; the cap is ${MAX_TEXT}`);
  problems.push(...validateGate(obj["gate"]));
  if (triggerOk && oncePerOk) {
    problems.push(...lintUnboundedBroadcast({
      pattern: obj["pattern"],
      event,
      gate: obj["gate"],
      once_per: oncePer,
      text,
      matcher
    }));
  }
  return problems;
}
var MAX_TEXT = 400, ONCE_PER;
var init_lint = __esm(() => {
  init_consts();
  init_gates();
  ONCE_PER = new Set(["session", "always"]);
});

// packages/nudges/src/dispatch-core.ts
function isRecord4(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function breadcrumb(sink, kind, sessionId, event, extra) {
  if (!sink.claimMarker(`breadcrumb-${kind}-${event}`))
    return;
  sink.breadcrumb({ ts: new Date().toISOString(), kind, session_id: sessionId, event, ...extra });
}
function dispatchWith(payload, nudges, sink, opts = {}) {
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
      if (!isRecord4(nudge) || nudge["event"] !== event)
        continue;
      const matcher = nudge["matcher"];
      if (matcher && payload["tool_name"] !== matcher)
        continue;
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
          budget_ms: gateTimeoutMs
        });
      }
      if (!matched)
        continue;
      if (nudge["once_per"] !== "always") {
        if (!sink.claimMarker(`nudge-${pattern}`))
          continue;
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
function lintLoadedNudges(files) {
  const nudges = [];
  const rejected = [];
  for (const { file, raw } of files) {
    if (!isRecord4(raw)) {
      rejected.push({ file, problems: ["not readable as a JSON object"] });
      continue;
    }
    const problems = lintNudge(raw);
    if (problems.length > 0) {
      rejected.push({ file, problems });
      continue;
    }
    nudges.push(raw);
  }
  return { nudges, rejected };
}
var DEFAULT_BUDGET_MS = 250, DEFAULT_GATE_TIMEOUT_MS = 50, GATE_MIN_SLICE_MS = 5;
var init_dispatch_core = __esm(() => {
  init_gates();
  init_lint();
});

// packages/nudges/src/dispatch.ts
import { readdirSync } from "fs";
import { join as join3 } from "path";
function loadNudgesDetailed(dirs) {
  const files = [];
  for (const d of dirs) {
    let names;
    try {
      names = readdirSync(d).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join3(d, name);
      files.push({ file, raw: readJsonOr(file, null) });
    }
  }
  return lintLoadedNudges(files);
}
function nodeSink(opts) {
  return {
    claimMarker: (name) => claimMarker(opts.sessionDir, name),
    fire: (record) => appendLine2(opts.fireLog, JSON.stringify(record)),
    breadcrumb: (record) => appendLine2(opts.fireLog, JSON.stringify(record))
  };
}
function dispatch(payload, nudges, opts) {
  return dispatchWith(payload, nudges, nodeSink(opts), { budgetMs: opts.budgetMs, gateTimeoutMs: opts.gateTimeoutMs });
}
var init_dispatch = __esm(() => {
  init_fsx();
  init_firelog();
  init_dispatch_core();
});

// packages/nudges/src/gate-runner.ts
var init_gate_runner = __esm(async () => {
  init_paths();
  init_gates();
  if (false) {}
});

// packages/nudges/src/index.ts
var init_src = __esm(async () => {
  init_dispatch();
  init_dispatch_core();
  init_gates();
  init_lint();
  init_firelog();
  await init_gate_runner();
});

// apps/hook/src/log.ts
var exports_log = {};
__export(exports_log, {
  excSummary: () => excSummary,
  log: () => log,
  nowIso: () => nowIso
});
function nowIso() {
  return new Date().toISOString();
}
function log(msg) {
  try {
    appendLine2(logFile("hook"), `${nowIso()} ${msg}`);
  } catch {}
}
function excSummary(e) {
  const name = e instanceof Error ? e.constructor.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message.slice(0, 120)}`;
}
var init_log = __esm(async () => {
  init_paths();
  await init_src();
});

// packages/core/src/hook-snapshot.ts
function defaultWorldFor(defaultTarget) {
  return {
    name: "default",
    repos: [],
    nudges_dir: `${defaultTarget}/nudges`,
    rules_file: `${defaultTarget}/RULES.md`,
    rules_inject: true
  };
}
function isRecord5(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str2(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
function coerceWorld(v) {
  if (!isRecord5(v))
    return null;
  const name = str2(v["name"], "");
  if (!name)
    return null;
  const repos = Array.isArray(v["repos"]) ? v["repos"].filter((r) => typeof r === "string" && r !== "") : [];
  return {
    name,
    repos,
    nudges_dir: str2(v["nudges_dir"], ""),
    rules_file: str2(v["rules_file"], ""),
    rules_inject: v["rules_inject"] !== false
  };
}
function coerceWorker(v) {
  if (!isRecord5(v))
    return { ...DEFAULT_WORKER };
  return {
    idle_minutes: num(v["idle_minutes"], DEFAULT_WORKER.idle_minutes),
    curriculum_interval_minutes: num(v["curriculum_interval_minutes"], DEFAULT_WORKER.curriculum_interval_minutes),
    min_tool_uses: num(v["min_tool_uses"], DEFAULT_WORKER.min_tool_uses),
    auto_kick: typeof v["auto_kick"] === "boolean" ? v["auto_kick"] : DEFAULT_WORKER.auto_kick
  };
}
function coerceSnapshot(obj, defaults) {
  if (!isRecord5(obj)) {
    return { version: 1, worlds: [defaults.defaultWorld], worker: { ...DEFAULT_WORKER }, plugin_root: defaults.pluginRoot };
  }
  const rawWorlds = Array.isArray(obj["worlds"]) ? obj["worlds"] : [];
  const worlds = rawWorlds.map(coerceWorld).filter((w) => w !== null);
  return {
    version: num(obj["version"], 1),
    worlds: worlds.length > 0 ? worlds : [defaults.defaultWorld],
    worker: coerceWorker(obj["worker"]),
    plugin_root: str2(obj["plugin_root"], "") || defaults.pluginRoot
  };
}
function cwdUnder(cwd, repo, realpath) {
  try {
    return isWithin(realpath(cwd), realpath(repo));
  } catch {
    return false;
  }
}
function resolveWorld(snapshot, cwd, realpath, fallbackWorld = defaultWorldFor("")) {
  const worlds = snapshot.worlds ?? [];
  const target = realpath(cwd);
  let best = null;
  let fallback = null;
  for (const w of worlds) {
    if (!w || typeof w !== "object")
      continue;
    const repos = w.repos ?? [];
    if (repos.length === 0 && fallback === null)
      fallback = w;
    for (const repo of repos) {
      const r = realpath(repo);
      if (isWithin(target, r)) {
        const score = r.split("/").length;
        if (!best || score > best.score)
          best = { score, world: w };
      }
    }
  }
  if (best)
    return best.world;
  if (fallback)
    return fallback;
  return fallbackWorld;
}
var DEFAULT_WORKER;
var init_hook_snapshot = __esm(() => {
  init_layout();
  DEFAULT_WORKER = {
    idle_minutes: 10,
    curriculum_interval_minutes: 60,
    min_tool_uses: 6,
    auto_kick: true
  };
});

// apps/hook/src/snapshot.ts
import { readFileSync as readFileSync3 } from "fs";
function defaultWorld() {
  return defaultWorldFor(defaultTarget("default"));
}
function defaultPluginRoot() {
  return process.env["CLAUDE_PLUGIN_ROOT"] ?? pluginRoot();
}
function loadSnapshot() {
  const defaults = { defaultWorld: defaultWorld(), pluginRoot: defaultPluginRoot() };
  let obj;
  try {
    obj = JSON.parse(readFileSync3(hookSnapshotFile(), "utf8"));
  } catch {}
  return coerceSnapshot(obj, defaults);
}
var init_snapshot = __esm(() => {
  init_paths();
  init_hook_snapshot();
});

// apps/hook/src/worlds.ts
import { realpathSync } from "fs";
import { resolve as resolve2 } from "path";
import { spawnSync } from "child_process";
function realOrResolve(p) {
  const abs = resolve2(expandHome(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
function expandHome(p) {
  if (p === "~")
    return process.env["HOME"] ?? p;
  if (p.startsWith("~/"))
    return `${process.env["HOME"] ?? ""}${p.slice(1)}`;
  return p;
}
function cwdUnder2(cwd, repo) {
  return cwdUnder(cwd, repo, realOrResolve);
}
function resolveWorld2(snapshot, cwd) {
  return resolveWorld(snapshot, cwd, realOrResolve, defaultWorld());
}
function gitHead(cwd) {
  try {
    const result = spawnSync("git", ["-C", cwd, "rev-parse", "HEAD"], {
      encoding: "utf8",
      timeout: 1000
    });
    if (result.status === 0) {
      const head = (result.stdout ?? "").trim();
      return head || null;
    }
  } catch {}
  return null;
}
var init_worlds = __esm(() => {
  init_hook_snapshot();
  init_snapshot();
});

// packages/core/src/lessons.ts
function formatLesson(lesson) {
  return `Lesson (${lesson["pattern"] ?? ""}): ${lesson["text"] ?? ""}`;
}
function rulesBlockFrom(text) {
  const start = text.indexOf(RULE_START);
  const end = text.indexOf(RULE_END);
  if (start === -1 || end === -1 || end <= start)
    return "";
  return text.slice(start + RULE_START.length, end).trim();
}
function isRecord6(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function selectLessons(candidates, delivered, cwdUnderRepo, limit, minMtime) {
  const chosen = [];
  for (const candidate of candidates) {
    if (delivered.has(candidate.stem))
      continue;
    if (minMtime !== null && candidate.mtimeMs < minMtime)
      continue;
    const raw = candidate.raw;
    if (!isRecord6(raw))
      continue;
    const id = typeof raw["id"] === "string" ? raw["id"] : raw["id"] != null ? String(raw["id"]) : "";
    if (!id || delivered.has(id))
      continue;
    const repo = raw["repo"];
    if (typeof repo === "string" && repo && !cwdUnderRepo(repo))
      continue;
    chosen.push({ obj: raw, path: candidate.path });
  }
  chosen.sort((a, b) => {
    const ca = String(a.obj["created"] ?? "");
    const cb = String(b.obj["created"] ?? "");
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
  return chosen.slice(0, limit);
}
var LESSON_ARCHIVE_AT_DELIVERIES = 5;
var init_lessons = __esm(() => {
  init_consts();
});

// apps/hook/src/lessons.ts
import { appendFileSync as appendFileSync3, mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, statSync as statSync3 } from "fs";
import { join as join4 } from "path";
function isRecord7(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function readDelivered(path) {
  try {
    const text = readFileSync4(path, "utf8");
    return new Set(text.split(`
`).map((l) => l.trim()).filter((l) => l.length > 0));
  } catch {
    return new Set;
  }
}
function bumpLessonDeliveries(worldName, path, raw) {
  let obj = raw ?? null;
  if (obj === null) {
    try {
      const parsed = JSON.parse(readFileSync4(path, "utf8"));
      if (isRecord7(parsed))
        obj = parsed;
    } catch {
      return;
    }
  }
  if (obj === null)
    return;
  const deliveries = (typeof obj["deliveries"] === "number" ? obj["deliveries"] : 0) + 1;
  obj["deliveries"] = deliveries;
  writeJsonAtomic(path, obj);
  if (deliveries >= LESSON_ARCHIVE_AT_DELIVERIES) {
    const archiveDir = join4(inboxDir(worldName), "archive");
    try {
      mkdirSync3(archiveDir, { recursive: true });
      renameSync2(path, join4(archiveDir, pathBasename(path)));
    } catch {}
  }
}
function pathBasename(p) {
  const idx = p.lastIndexOf("/");
  return idx === -1 ? p : p.slice(idx + 1);
}
function writeJsonAtomic(path, obj) {
  atomicWrite(path, `${JSON.stringify(obj, null, 2)}
`);
}
function sessionStartMtime(sessionId) {
  const dir = sessionDir(sessionId);
  try {
    return statSync3(join4(dir, "start.json")).mtimeMs;
  } catch {}
  try {
    return statSync3(dir).mtimeMs;
  } catch {
    return null;
  }
}
function pendingLessons(worldName, sessionId, cwd, limit, sinceSessionStart = false) {
  let minMtime = null;
  if (sinceSessionStart) {
    minMtime = sessionStartMtime(sessionId);
    if (minMtime === null)
      return [];
  }
  const inbox = inboxDir(worldName);
  let names;
  try {
    names = readdirSync2(inbox).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const deliveredFile = join4(sessionDir(sessionId), "delivered");
  const already = readDelivered(deliveredFile);
  const candidates = [];
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    if (already.has(stem))
      continue;
    const path = join4(inbox, name);
    let mtimeMs = 0;
    if (minMtime !== null) {
      try {
        mtimeMs = statSync3(path).mtimeMs;
      } catch {
        continue;
      }
      if (mtimeMs < minMtime)
        continue;
    }
    let raw;
    try {
      raw = JSON.parse(readFileSync4(path, "utf8"));
    } catch {
      continue;
    }
    candidates.push({ path, stem, mtimeMs, raw });
  }
  const chosen = selectLessons(candidates, already, (repo) => cwdUnder2(cwd, repo), limit, minMtime);
  for (const { obj, path } of chosen) {
    try {
      mkdirSync3(sessionDir(sessionId), { recursive: true });
      appendFileSync3(deliveredFile, `${String(obj["id"])}
`, "utf8");
    } catch {}
    bumpLessonDeliveries(worldName, path, obj);
  }
  return chosen.map((c) => c.obj);
}
function rulesBlock(world) {
  if (world.rules_inject === false)
    return "";
  const rulesFile = world.rules_file;
  if (!rulesFile)
    return "";
  try {
    const st = statSync3(rulesFile);
    if (!st.isFile() || st.size > MAX_RULES_BYTES)
      return "";
  } catch {
    return "";
  }
  let text;
  try {
    text = readFileSync4(rulesFile, "utf8");
  } catch {
    return "";
  }
  return rulesBlockFrom(text);
}
var MAX_RULES_BYTES;
var init_lessons2 = __esm(() => {
  init_paths();
  init_lessons();
  init_fsx();
  init_worlds();
  init_lessons();
  MAX_RULES_BYTES = 256 * 1024;
});

// apps/hook/src/kick.ts
import { closeSync, existsSync as existsSync4, mkdirSync as mkdirSync4, openSync, readFileSync as readFileSync5, readdirSync as readdirSync3, statSync as statSync4, utimesSync, writeFileSync as writeFileSync3 } from "fs";
import { join as join5 } from "path";
import { spawn } from "child_process";
function lastKickPath() {
  return `${stateDir()}/last-kick`;
}
function curriculumMarkerPath(worldName) {
  return `${stateDir()}/last-curriculum-${worldName}`;
}
function workerLockPid() {
  try {
    const text = readFileSync5(workerLockFile(), "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}
function workerRunning() {
  const pid = workerLockPid();
  if (pid === null)
    return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = e.code;
    if (code === "EPERM")
      return true;
    return false;
  }
}
function curriculumDueForAnyWorld(snapshot, intervalMinutes) {
  const worlds = snapshot.worlds?.length ? snapshot.worlds : [defaultWorld()];
  const intervalS = Number.isFinite(intervalMinutes) ? Math.max(intervalMinutes, 0) * 60 : DEFAULT_WORKER.curriculum_interval_minutes * 60;
  for (const w of worlds) {
    if (!w || typeof w !== "object")
      continue;
    const marker = curriculumMarkerPath(w.name || "default");
    try {
      const st = statSync4(marker);
      if (Date.now() / 1000 - st.mtimeMs / 1000 >= intervalS)
        return true;
    } catch {
      return true;
    }
  }
  return false;
}
function hasPendingWork(snapshot, workerCfg) {
  try {
    if (readdirSync3(queueDir("pending")).length > 0)
      return true;
  } catch {}
  const interval = workerCfg.curriculum_interval_minutes ?? DEFAULT_WORKER.curriculum_interval_minutes;
  return curriculumDueForAnyWorld(snapshot, interval);
}
function resolveWorkerCommand(pluginRoot) {
  const built = join5(pluginRoot, "dist", "cli.js");
  if (existsSync4(built))
    return ["bun", built, "worker", "--once"];
  return ["bun", "run", join5(pluginRoot, "apps", "cli", "src", "main.ts"), "worker", "--once"];
}
function maybeKickWorker(snapshot) {
  if (!existsSync4(hookSnapshotFile()))
    return;
  const workerCfg = snapshot.worker ?? DEFAULT_WORKER;
  if (workerCfg.auto_kick === false)
    return;
  if (workerRunning())
    return;
  const lastKick = lastKickPath();
  try {
    const age = Date.now() - statSync4(lastKick).mtimeMs;
    if (age < WORKER_KICK_THROTTLE_MS)
      return;
  } catch {}
  if (!hasPendingWork(snapshot, workerCfg))
    return;
  try {
    mkdirSync4(stateDir(), { recursive: true });
    const now = new Date;
    if (existsSync4(lastKick))
      utimesSync(lastKick, now, now);
    else
      writeFileSync3(lastKick, "");
  } catch {
    return;
  }
  const pluginRoot2 = process.env["CLAUDE_PLUGIN_ROOT"] || snapshot.plugin_root || pluginRoot();
  const cmd = resolveWorkerCommand(pluginRoot2);
  const testLog = spawnLogOverride;
  if (testLog) {
    try {
      writeFileSync3(testLog, `${JSON.stringify(cmd)}
`, { flag: "a" });
    } catch {}
    return;
  }
  const logPath = logFile("worker");
  let fd;
  try {
    mkdirSync4(`${stateDir()}/logs`, { recursive: true });
    fd = openSync(logPath, "a");
  } catch {
    return;
  }
  try {
    const child = spawn(cmd[0], cmd.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
      cwd: pluginRoot2
    });
    child.unref();
  } catch {} finally {
    try {
      closeSync(fd);
    } catch {}
  }
}
var WORKER_KICK_THROTTLE_MS, spawnLogOverride = null;
var init_kick = __esm(() => {
  init_paths();
  init_snapshot();
  WORKER_KICK_THROTTLE_MS = 15 * 60 * 1000;
});

// apps/hook/src/queue.ts
import { existsSync as existsSync5, mkdirSync as mkdirSync5, readFileSync as readFileSync6 } from "fs";
function isRecord8(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function queuePath(sessionId) {
  return `${queueDir("pending")}/${safeComponent(sessionId)}.json`;
}
function readQueueEntry(qpath) {
  try {
    const parsed = JSON.parse(readFileSync6(qpath, "utf8"));
    if (isRecord8(parsed))
      return parsed;
  } catch {}
  return {};
}
function writeQueueEntry(qpath, entry) {
  atomicWrite(qpath, `${JSON.stringify(entry, null, 2)}
`);
}
function str3(v) {
  return typeof v === "string" ? v : null;
}
function truthyStr(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function hasTranscript(payload, sessionId) {
  const claimed = truthyStr(payload["transcript_path"]);
  if (claimed === null)
    return true;
  if (existsSync5(claimed))
    return true;
  return Object.keys(readQueueEntry(queuePath(sessionId))).length > 0;
}
function startGitHead(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync6(`${sessionDir(sessionId)}/start.json`, "utf8"));
    return isRecord8(parsed) ? str3(parsed["git_head"]) : null;
  } catch {
    return null;
  }
}
function upsertStopQueue(payload, worldName, sessionId) {
  const now = nowIso();
  const cwd = truthyStr(payload["cwd"]) ?? process.cwd();
  const qpath = queuePath(sessionId);
  const existing = readQueueEntry(qpath);
  const gitHeadValue = truthyStr(existing["git_head"]) ?? startGitHead(sessionId) ?? gitHead(cwd);
  const entry = {
    session_id: sessionId,
    transcript_path: truthyStr(payload["transcript_path"]) ?? truthyStr(existing["transcript_path"]),
    cwd,
    world: worldName,
    git_head: gitHeadValue,
    first_stop: truthyStr(existing["first_stop"]) ?? now,
    last_stop: now,
    stops: (typeof existing["stops"] === "number" ? existing["stops"] : 0) + 1,
    ended: existing["ended"] === true,
    tool_uses: typeof existing["tool_uses"] === "number" ? existing["tool_uses"] : 0,
    result: str3(existing["result"])
  };
  writeQueueEntry(qpath, entry);
}
function bumpToolUses(sessionId, count) {
  if (!count)
    return;
  const qpath = queuePath(sessionId);
  let obj;
  try {
    const parsed = JSON.parse(readFileSync6(qpath, "utf8"));
    if (!isRecord8(parsed))
      return;
    obj = parsed;
  } catch {
    return;
  }
  obj["tool_uses"] = (typeof obj["tool_uses"] === "number" ? obj["tool_uses"] : 0) + count;
  writeQueueEntry(qpath, obj);
}
function markQueueEnded(payload, worldName, sessionId) {
  const now = nowIso();
  const cwd = truthyStr(payload["cwd"]) ?? process.cwd();
  const qpath = queuePath(sessionId);
  const existing = readQueueEntry(qpath);
  const obj = Object.keys(existing).length > 0 ? existing : {
    session_id: sessionId,
    transcript_path: str3(payload["transcript_path"]),
    cwd,
    world: worldName,
    git_head: startGitHead(sessionId),
    first_stop: now,
    last_stop: now,
    stops: 0,
    tool_uses: 0,
    result: null
  };
  obj["ended"] = true;
  writeQueueEntry(qpath, obj);
}
function sessionLock(sessionId, fn, staleMs) {
  const sdir = sessionDir(sessionId);
  mkdirSync5(sdir, { recursive: true });
  return withDirLock(`${sdir}/lock.lockdir`, fn, staleMs);
}
var init_queue = __esm(async () => {
  init_paths();
  init_fsx();
  init_worlds();
  await __promiseAll([
    init_src(),
    init_log()
  ]);
});

// apps/hook/src/scan.ts
import { closeSync as closeSync2, openSync as openSync2, readSync, readFileSync as readFileSync7, statSync as statSync5 } from "fs";
function isRecord9(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assistantContent(record) {
  const message = record["message"];
  if (isRecord9(message) && Array.isArray(message["content"]))
    return message["content"];
  const content = record["content"];
  return Array.isArray(content) ? content : [];
}
function offsetPath(sessionId) {
  return `${sessionDir(sessionId)}/offset`;
}
function readOffset(path) {
  try {
    const text = readFileSync7(path, "utf8").trim();
    const n = Number.parseInt(text || "0", 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}
function writeOffset(path, value) {
  try {
    atomicWrite(path, String(value));
  } catch {}
}
function scanTranscript(payload, sessionId, emit) {
  const transcriptPath = payload["transcript_path"];
  if (typeof transcriptPath !== "string" || !transcriptPath)
    return;
  let size;
  try {
    size = statSync5(transcriptPath).size;
  } catch {
    return;
  }
  const offPath = offsetPath(sessionId);
  let offset = readOffset(offPath);
  if (offset > size)
    offset = 0;
  let data;
  let fd;
  try {
    fd = openSync2(transcriptPath, "r");
  } catch {
    return;
  }
  try {
    const toRead = Math.min(MAX_TRANSCRIPT_SCAN_BYTES, size - offset);
    const buf = Buffer.alloc(Math.max(toRead, 0));
    const bytesRead = toRead > 0 ? readSync(fd, buf, 0, toRead, offset) : 0;
    data = buf.subarray(0, bytesRead);
  } catch {
    return;
  } finally {
    closeSync2(fd);
  }
  const lastNl = data.lastIndexOf(10);
  if (lastNl === -1 && data.length >= MAX_TRANSCRIPT_SCAN_BYTES) {
    log(`transcript line exceeds ${MAX_TRANSCRIPT_SCAN_BYTES} bytes, skipping`);
    writeOffset(offPath, offset + data.length);
    return;
  }
  const usable = lastNl !== -1 ? data.subarray(0, lastNl + 1) : Buffer.alloc(0);
  const newOffset = offset + usable.length;
  let toolUses = 0;
  for (const rawLine of usable.toString("utf8").split(`
`)) {
    const line = rawLine.trim();
    if (!line)
      continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord9(record))
      continue;
    const rtype = record["type"];
    if (rtype === "attachment") {
      const attachmentRaw = record["attachment"];
      const attachment = isRecord9(attachmentRaw) ? attachmentRaw : {};
      const hookName = attachment["hookName"];
      const attType = attachment["type"];
      if (attType === "hook_success" || attType === "hook_error" || attType === "hook_blocked" || hookName) {
        emit("hook_run", `hook:${typeof hookName === "string" && hookName ? hookName : "unknown"}`, {
          exitCode: attachment["exitCode"] ?? null,
          durationMs: attachment["durationMs"] ?? null,
          hookEvent: attachment["hookEvent"] ?? null
        });
      }
    } else if (rtype === "assistant") {
      for (const block of assistantContent(record)) {
        if (isRecord9(block) && block["type"] === "tool_use")
          toolUses++;
      }
    }
  }
  bumpToolUses(sessionId, toolUses);
  writeOffset(offPath, newOffset);
}
var MAX_TRANSCRIPT_SCAN_BYTES;
var init_scan = __esm(async () => {
  init_fsx();
  init_paths();
  await __promiseAll([
    init_log(),
    init_queue()
  ]);
  MAX_TRANSCRIPT_SCAN_BYTES = 20 * 1024 * 1024;
});

// packages/core/src/spool.ts
function isRecord10(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function parseTarget(v) {
  if (!isRecord10(v))
    return null;
  const kind = v["kind"];
  if (kind === "usage-events" || kind === "hook-runs" || kind === "nudge-fires")
    return { kind };
  if (kind === "payload-samples") {
    const world = v["world"];
    return typeof world === "string" && world ? { kind, world } : null;
  }
  if (kind === "session-file") {
    const name = v["name"];
    return typeof name === "string" && name ? { kind, name } : null;
  }
  return null;
}
function parseAppend(v) {
  if (!isRecord10(v))
    return null;
  const target = parseTarget(v["target"]);
  const line = v["line"];
  if (!target || typeof line !== "string")
    return null;
  return { target, line };
}
function parseMove(v) {
  if (!isRecord10(v))
    return null;
  const from = v["from"];
  const to = v["to"];
  if (typeof from !== "string" || !from || typeof to !== "string" || !to)
    return null;
  return { from, to };
}
function parseSpool(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord10(parsed))
    return null;
  if (parsed["version"] !== SPOOL_VERSION)
    return null;
  const sessionId = parsed["session_id"];
  if (typeof sessionId !== "string" || !sessionId)
    return null;
  const rawAppends = parsed["appends"];
  const rawMoves = parsed["moves"];
  if (!Array.isArray(rawAppends) || !Array.isArray(rawMoves))
    return null;
  const appends = [];
  for (const a of rawAppends) {
    const parsedAppend = parseAppend(a);
    if (parsedAppend)
      appends.push(parsedAppend);
  }
  const moves = [];
  for (const m of rawMoves) {
    const parsedMove = parseMove(m);
    if (parsedMove)
      moves.push(parsedMove);
  }
  const writtenAt = typeof parsed["written_at"] === "string" ? parsed["written_at"] : "";
  return { version: SPOOL_VERSION, session_id: sessionId, written_at: writtenAt, appends, moves };
}
var SPOOL_VERSION = 1, SPOOL_FILE_NAME = "module-spool.json";

// apps/hook/src/usage-log.ts
import { appendFileSync as appendFileSync4, mkdirSync as mkdirSync6 } from "fs";
import { dirname as dirname4 } from "path";
function appendUsageEvent(path, event) {
  try {
    mkdirSync6(dirname4(path), { recursive: true });
    appendFileSync4(path, `${JSON.stringify(event)}
`, { encoding: "utf8", flag: "a" });
  } catch (e) {
    if (usageFailureLogged)
      return;
    usageFailureLogged = true;
    log(`usage.append_event failed for ${path}: ${e.message}`);
  }
}
function appendHookRun(event) {
  try {
    appendLine(hookRunsFile(), JSON.stringify(event), HOOK_RUNS_ROTATE_AT_BYTES, HOOK_RUNS_KEEP_LINES);
  } catch (e) {
    if (hookRunFailureLogged)
      return;
    hookRunFailureLogged = true;
    log(`usage.append_hook_run failed: ${e.message}`);
  }
}
var usageFailureLogged = false, HOOK_RUNS_ROTATE_AT_BYTES, HOOK_RUNS_KEEP_LINES = 40000, hookRunFailureLogged = false;
var init_usage_log = __esm(async () => {
  init_paths();
  init_fsx();
  await init_log();
  HOOK_RUNS_ROTATE_AT_BYTES = 8 * 1024 * 1024;
});

// apps/hook/src/spool-ingest.ts
import { appendFileSync as appendFileSync5, existsSync as existsSync6, mkdirSync as mkdirSync7, readdirSync as readdirSync4, readFileSync as readFileSync8, renameSync as renameSync3, rmSync as rmSync2, statSync as statSync6 } from "fs";
import { dirname as dirname5, resolve as resolve3, sep } from "path";
function spoolPath(sessionId) {
  return `${sessionDir(sessionId)}/${SPOOL_FILE_NAME}`;
}
function isSafeSessionFileName(name) {
  return name.length > 0 && !name.includes("/") && !name.includes("..");
}
function withinStateDir(p) {
  const stateDir2 = resolve3(stateDir());
  const resolved = resolve3(p);
  return resolved === stateDir2 || resolved.startsWith(`${stateDir2}${sep}`);
}
function plainAppend(path, line) {
  mkdirSync7(dirname5(path), { recursive: true });
  appendFileSync5(path, line.endsWith(`
`) ? line : `${line}
`, "utf8");
}
function tryParseLine(line) {
  try {
    const obj = JSON.parse(line);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : null;
  } catch {
    return null;
  }
}
function makeFailureReporter(sessionId) {
  let logged = false;
  return (detail) => {
    if (logged)
      return;
    logged = true;
    log(`spool ingest for session ${sessionId} could not write, further failures this ingest are not logged individually: ${detail}`);
  };
}
function flushGroup(path, lines, writer, rotateAt, keep, reportFailure) {
  if (lines.length === 0)
    return { applied: 0, skipped: 0 };
  try {
    writer(path, lines.join(`
`), rotateAt, keep);
    return { applied: lines.length, skipped: 0 };
  } catch (e) {
    reportFailure(e.message);
    return { applied: 0, skipped: lines.length };
  }
}
function applyAppends(appends, sessionId, reportFailure) {
  let applied = 0;
  let skipped = 0;
  const nudgeFiresLines = [];
  const hookRunsLines = [];
  const samplesByWorld = new Map;
  for (const a of appends) {
    const target = a.target;
    switch (target.kind) {
      case "nudge-fires":
        nudgeFiresLines.push(a.line);
        break;
      case "hook-runs": {
        const obj = tryParseLine(a.line);
        if (!obj) {
          log(`spool append dropped, invalid JSON for hook-runs (session ${sessionId})`);
          skipped++;
          break;
        }
        hookRunsLines.push(JSON.stringify(obj));
        break;
      }
      case "payload-samples": {
        const bucket = samplesByWorld.get(target.world) ?? [];
        bucket.push(a.line);
        samplesByWorld.set(target.world, bucket);
        break;
      }
      case "usage-events": {
        try {
          const obj = tryParseLine(a.line);
          if (!obj) {
            log(`spool append dropped, invalid JSON for usage-events (session ${sessionId})`);
            skipped++;
            break;
          }
          appendUsageEvent(usageEventsFile(), obj);
          applied++;
        } catch (e) {
          reportFailure(e.message);
          skipped++;
        }
        break;
      }
      case "session-file": {
        try {
          if (!isSafeSessionFileName(target.name)) {
            log(`spool append refused, unsafe session file name "${target.name}" (session ${sessionId})`);
            skipped++;
            break;
          }
          plainAppend(`${sessionDir(sessionId)}/${target.name}`, a.line);
          applied++;
        } catch (e) {
          reportFailure(e.message);
          skipped++;
        }
        break;
      }
    }
  }
  const nudgeFires = flushGroup(nudgeFiresFile(), nudgeFiresLines, appendLine2, ROTATE_AT_BYTES2, ROTATE_KEEP_LINES2, reportFailure);
  applied += nudgeFires.applied;
  skipped += nudgeFires.skipped;
  const hookRuns = flushGroup(hookRunsFile(), hookRunsLines, appendLine, HOOK_RUNS_ROTATE_AT_BYTES, HOOK_RUNS_KEEP_LINES, reportFailure);
  applied += hookRuns.applied;
  skipped += hookRuns.skipped;
  for (const [world, lines] of samplesByWorld) {
    const samples = flushGroup(payloadSamplesFile(world), lines, appendLine, SAMPLES_ROTATE_AT_BYTES, SAMPLES_KEEP_LINES, reportFailure);
    applied += samples.applied;
    skipped += samples.skipped;
  }
  return { applied, skipped };
}
function applyMove(m, sessionId) {
  if (!withinStateDir(m.from) || !withinStateDir(m.to)) {
    log(`spool move refused, outside state dir (session ${sessionId}): ${m.from} -> ${m.to}`);
    return "refused";
  }
  if (!existsSync6(m.from))
    return "missing";
  try {
    mkdirSync7(dirname5(m.to), { recursive: true });
    renameSync3(m.from, m.to);
    return "applied";
  } catch (e) {
    log(`spool move failed (session ${sessionId}): ${e.message}`);
    return "failed";
  }
}
function deleteSpool(file) {
  try {
    rmSync2(file, { force: true });
  } catch (e) {
    log(`spool could not be deleted, ${file}: ${e.message}`);
  }
}
function ingestSpool(sessionId) {
  const file = spoolPath(sessionId);
  let text;
  try {
    text = readFileSync8(file, "utf8");
  } catch {
    return { appends: 0, moves: 0, skipped: 0 };
  }
  const spool = parseSpool(text);
  if (!spool) {
    log(`spool for session ${sessionId} could not be parsed, discarding`);
    deleteSpool(file);
    return { appends: 0, moves: 0, skipped: 1 };
  }
  if (spool.session_id !== sessionId) {
    log(`spool session_id mismatch for ${sessionId}: file claims ${spool.session_id}, discarding`);
    deleteSpool(file);
    return { appends: 0, moves: 0, skipped: 1 };
  }
  const reportFailure = makeFailureReporter(sessionId);
  const { applied: appends, skipped: appendSkipped } = applyAppends(spool.appends, sessionId, reportFailure);
  let moves = 0;
  let moveSkipped = 0;
  for (const m of spool.moves) {
    const result = applyMove(m, sessionId);
    if (result === "applied")
      moves++;
    else if (result === "refused" || result === "failed")
      moveSkipped++;
  }
  deleteSpool(file);
  return { appends, moves, skipped: appendSkipped + moveSkipped };
}
function sweepOrphanSpools(opts) {
  let entries;
  try {
    entries = readdirSync4(`${stateDir()}/sessions`);
  } catch {
    return { swept: 0 };
  }
  const cutoff = Date.now() - opts.olderThanMs;
  let swept = 0;
  for (const sessionId of entries) {
    if (swept >= opts.limit)
      break;
    let mtimeMs;
    try {
      mtimeMs = statSync6(spoolPath(sessionId)).mtimeMs;
    } catch {
      continue;
    }
    if (mtimeMs > cutoff)
      continue;
    try {
      sessionLock(sessionId, () => ingestSpool(sessionId), ORPHAN_LOCK_WAIT_MS);
      swept++;
    } catch {}
  }
  return { swept };
}
var ORPHAN_SPOOL_OLDER_THAN_MS, ORPHAN_SPOOL_SWEEP_LIMIT = 5, ORPHAN_LOCK_WAIT_MS = 200;
var init_spool_ingest = __esm(async () => {
  init_paths();
  init_fsx();
  init_samples();
  await __promiseAll([
    init_src(),
    init_log(),
    init_usage_log(),
    init_queue()
  ]);
  ORPHAN_SPOOL_OLDER_THAN_MS = 30 * 60 * 1000;
});

// apps/hook/src/handlers.ts
import { readFileSync as readFileSync9, statSync as statSync7 } from "fs";
function artifactRef(kind, name) {
  return `${kind}:${name}`;
}
function isRecord11(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function recordPayloadSample(payload, worldName) {
  try {
    const record = sampleRecord(payload, nowIso());
    if (!record)
      return;
    appendLine(payloadSamplesFile(worldName), JSON.stringify(record), SAMPLES_ROTATE_AT_BYTES, SAMPLES_KEEP_LINES);
  } catch (e) {
    if (sampleFailureLogged)
      return;
    sampleFailureLogged = true;
    log(`usage.record_payload_sample failed for world ${worldName}: ${e.message}`);
  }
}
function recordRuleUses(rulesText, worldName, sessionId) {
  const sessionDir2 = sessionDir(sessionId);
  for (const match of new Set([...rulesText.matchAll(RULE_TAG_RE)].map((m) => m[1] ?? ""))) {
    if (!match || !claimMarker(sessionDir2, `rule-use-${match}`))
      continue;
    appendUsageEvent(usageEventsFile(), {
      ts: nowIso(),
      session_id: sessionId,
      world: worldName,
      kind: "rule",
      ref: artifactRef("rule", match),
      detail: {}
    });
  }
}
function isDir(path) {
  try {
    return statSync7(path).isDirectory();
  } catch {
    return false;
  }
}
function dispatchNudge(payload, world, sessionId) {
  const event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";
  const sdir = sessionDir(sessionId);
  const worldDir = world.nudges_dir;
  const dirs = typeof worldDir === "string" && worldDir.trim() ? [worldDir] : [];
  dirs.push(builtinNudgesDir());
  if (!dirs.some(isDir)) {
    writeBreadcrumb(nudgeFiresFile(), sdir, "nudge_dir_missing", sessionId, event);
  }
  const { nudges, rejected } = loadNudgesDetailed(dirs);
  for (const r of rejected) {
    writeBreadcrumb(nudgeFiresFile(), sdir, "nudge_invalid", sessionId, event, { file: r.file, problems: r.problems.slice(0, 3) }, `nudge_invalid-${r.file}`);
  }
  return dispatch(payload, nudges, { sessionDir: sdir, fireLog: nudgeFiresFile() }) ?? "";
}
function sessionIdOf(payload) {
  return typeof payload["session_id"] === "string" && payload["session_id"] ? payload["session_id"] : "unknown";
}
function cwdOf(payload) {
  return typeof payload["cwd"] === "string" && payload["cwd"] ? payload["cwd"] : process.cwd();
}
function writeStartJson(sessionId, obj) {
  atomicWrite(`${sessionDir(sessionId)}/start.json`, `${JSON.stringify(obj, null, 2)}
`);
}
function handleSessionStart(payload, world, snapshot) {
  const sessionId = sessionIdOf(payload);
  const cwd = cwdOf(payload);
  const worldName = world.name || "default";
  const parts = [];
  const rulesText = rulesBlock(world);
  if (rulesText)
    parts.push(`Promoted rules for world ${worldName}:
${rulesText}`);
  const lessons = pendingLessons(worldName, sessionId, cwd, 3);
  if (lessons.length > 0)
    parts.push(lessons.map(formatLesson).join(`
`));
  parts.push("self-improvement-loop is active: /reflect queues this session for " + "background reflection, /loop shows status, /feedback <type>:<name> " + "good|bad rates an artifact.");
  const nudgeText = dispatchNudge(payload, world, sessionId);
  if (nudgeText)
    parts.push(nudgeText);
  try {
    if (rulesText)
      recordRuleUses(rulesText, worldName, sessionId);
  } catch (e) {
    log(`SessionStart could not record rule uses: ${e.message}`);
  }
  try {
    writeStartJson(sessionId, { ts: nowIso(), cwd: String(cwd), world: worldName, git_head: gitHead(cwd) });
  } catch (e) {
    log(`SessionStart could not write start.json: ${e.message}`);
  }
  try {
    maybeKickWorker(snapshot);
  } catch (e) {
    log(`SessionStart could not kick the worker: ${e.message}`);
  }
  return parts.filter((p) => p).join(`

`);
}
function handleUserPromptSubmit(payload, world) {
  const sessionId = sessionIdOf(payload);
  const cwd = cwdOf(payload);
  const worldName = world.name || "default";
  const parts = [];
  const lessons = pendingLessons(worldName, sessionId, cwd, 2, true);
  if (lessons.length > 0)
    parts.push(lessons.map(formatLesson).join(`
`));
  const nudgeText = dispatchNudge(payload, world, sessionId);
  if (nudgeText)
    parts.push(nudgeText);
  return parts.filter((p) => p).join(`

`);
}
function handlePreToolUse(payload, world) {
  recordPayloadSample(payload, world.name || "default");
  return dispatchNudge(payload, world, sessionIdOf(payload));
}
function handlePostToolUse(payload, world) {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  const toolName = payload["tool_name"];
  const toolInputRaw = payload["tool_input"];
  const toolInput = isRecord11(toolInputRaw) ? toolInputRaw : {};
  if (toolName === "Skill") {
    appendUsageEvent(usageEventsFile(), {
      ts: nowIso(),
      session_id: sessionId,
      world: worldName,
      kind: "skill",
      ref: artifactRef("skill", String(toolInput["skill"] ?? "")),
      detail: {}
    });
  } else if (toolName === "Agent") {
    appendUsageEvent(usageEventsFile(), {
      ts: nowIso(),
      session_id: sessionId,
      world: worldName,
      kind: "agent",
      ref: artifactRef("agent", String(toolInput["subagent_type"] ?? "")),
      detail: { model: toolInput["model"] ?? null }
    });
  }
  return dispatchNudge(payload, world, sessionId);
}
function handleStop(payload, world) {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  if (payload["stop_hook_active"] !== true) {
    sessionLock(sessionId, () => {
      ingestSpool(sessionId);
      if (!hasTranscript(payload, sessionId)) {
        log(`Stop not queued for ${sessionId}: transcript not on disk (session not persisted)`);
        return;
      }
      upsertStopQueue(payload, worldName, sessionId);
      scanTranscript(payload, sessionId, (kind, ref, detail) => {
        const event = { ts: nowIso(), session_id: sessionId, world: worldName, kind, ref, detail };
        if (kind === "hook_run")
          appendHookRun(event);
        else
          appendUsageEvent(usageEventsFile(), event);
      });
    });
  }
  sweepOrphanSpools({ olderThanMs: ORPHAN_SPOOL_OLDER_THAN_MS, limit: ORPHAN_SPOOL_SWEEP_LIMIT });
  return "";
}
function truthy(v) {
  return typeof v === "string" && v ? v : null;
}
function handleSubagentStop(payload, world) {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  const agentType = truthy(payload["agent_type"]) ?? truthy(payload["subagent_type"]) ?? truthy(payload["agentType"]) ?? "unknown";
  appendUsageEvent(usageEventsFile(), {
    ts: nowIso(),
    session_id: sessionId,
    world: worldName,
    kind: "agent_stop",
    ref: artifactRef("agent", agentType),
    detail: { subagent_type: agentType }
  });
  return "";
}
function handleSessionEnd(payload, world) {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  sessionLock(sessionId, () => {
    ingestSpool(sessionId);
    if (!hasTranscript(payload, sessionId)) {
      log(`SessionEnd not queued for ${sessionId}: transcript not on disk (session not persisted)`);
      return;
    }
    markQueueEnded(payload, worldName, sessionId);
  }, SESSION_END_LOCK_MS);
  sweepOrphanSpools({ olderThanMs: ORPHAN_SPOOL_OLDER_THAN_MS, limit: ORPHAN_SPOOL_SWEEP_LIMIT });
  return "";
}
function getHandler(event) {
  if (!Object.hasOwn(HANDLERS, event))
    return;
  return HANDLERS[event];
}
var sampleFailureLogged = false, RULE_TAG_RE, SESSION_END_LOCK_MS = 4000, HANDLERS;
var init_handlers = __esm(async () => {
  init_paths();
  init_fsx();
  init_samples();
  init_worlds();
  init_lessons2();
  init_kick();
  init_samples();
  await __promiseAll([
    init_src(),
    init_log(),
    init_queue(),
    init_scan(),
    init_spool_ingest(),
    init_usage_log()
  ]);
  RULE_TAG_RE = /<!--\s*rule:([A-Za-z0-9._-]+)\s*-->/g;
  HANDLERS = {
    SessionStart: handleSessionStart,
    UserPromptSubmit: handleUserPromptSubmit,
    PreToolUse: handlePreToolUse,
    PostToolUse: handlePostToolUse,
    Stop: handleStop,
    SubagentStop: handleSubagentStop,
    SessionEnd: handleSessionEnd
  };
});

// apps/hook/src/main.ts
import { appendFileSync as appendFileSync6, mkdirSync as mkdirSync8 } from "fs";
import { homedir as homedir2 } from "os";
var OUTPUT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
var SLOW_INVOCATION_MS = 150;
function expandHome2(p) {
  if (p === "~")
    return homedir2();
  if (p.startsWith("~/"))
    return `${homedir2()}${p.slice(1)}`;
  return p;
}
function fallbackStateDir() {
  const raw = process.env["SIL_STATE_DIR"];
  if (raw)
    return expandHome2(raw);
  const xdg = process.env["XDG_STATE_HOME"];
  const base = xdg ? expandHome2(xdg) : `${homedir2()}/.local/state`;
  return `${base}/self-improvement-loop`;
}
function fallbackLog(msg) {
  try {
    const dir = `${fallbackStateDir()}/logs`;
    mkdirSync8(dir, { recursive: true });
    appendFileSync6(`${dir}/hook.log`, `${new Date().toISOString()} ${msg}
`, "utf8");
  } catch {}
}
async function readPayload() {
  let raw;
  try {
    raw = await Bun.stdin.text();
  } catch {
    return {};
  }
  if (!raw || !raw.trim())
    return {};
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {};
  } catch {
    return {};
  }
}
async function main() {
  const started = performance.now();
  let text = "";
  let event = "";
  let logMod = null;
  try {
    const payload = await readPayload();
    event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";
    const [handlersMod, snapshotMod, worldsMod, loaded] = await Promise.all([
      init_handlers().then(() => ({})),
      Promise.resolve().then(() => (init_snapshot(), {})),
      Promise.resolve().then(() => (init_worlds(), {})),
      init_log().then(() => exports_log)
    ]);
    logMod = loaded;
    const snapshot = loadSnapshot();
    const cwd = typeof payload["cwd"] === "string" && payload["cwd"] ? payload["cwd"] : process.cwd();
    const world = resolveWorld2(snapshot, cwd);
    const handler = getHandler(event);
    if (handler) {
      try {
        text = handler(payload, world, snapshot) || "";
      } catch (e) {
        logMod.log(`${event} handler failed: ${logMod.excSummary(e)}`);
        text = "";
      }
    }
  } catch (e) {
    if (logMod) {
      logMod.log(`hook invocation failed: ${logMod.excSummary(e)}`);
    } else {
      const name = e instanceof Error ? e.constructor.name : "Error";
      fallbackLog(`hook unavailable: import failed: ${name}`);
    }
    text = "";
  }
  if (text && OUTPUT_EVENTS.has(event)) {
    try {
      console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } }));
    } catch {}
  }
  const elapsedMs = performance.now() - started;
  if (elapsedMs > SLOW_INVOCATION_MS && logMod) {
    logMod.log(`slow hook invocation: event=${event} elapsed_ms=${elapsedMs.toFixed(1)}`);
  }
}
try {
  await main();
} catch {}
process.exit(0);
