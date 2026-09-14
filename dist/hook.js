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

// packages/core/src/paths.ts
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
function envPath(name, fallback) {
  const raw = process.env[name];
  return raw && raw.length > 0 ? expandHome(raw) : fallback;
}
function expandHome(p) {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}
function stateDir() {
  return envPath("SIL_STATE_DIR", join(envPath("XDG_STATE_HOME", join(homedir(), ".local", "state")), "self-improvement-loop"));
}
function dataDir() {
  return envPath("SIL_DATA_DIR", join(envPath("XDG_DATA_HOME", join(homedir(), ".local", "share")), "self-improvement-loop"));
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
function safeComponent(name) {
  const cleaned = Array.from(name.normalize("NFC"), (c) => SAFE_CHAR.test(c) ? c : "_").join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}
var manifestRoot, queueDir = (bucket) => join(stateDir(), "queue", bucket), usageEventsFile = () => join(stateDir(), "usage", "events.jsonl"), nudgeFiresFile = () => join(stateDir(), "usage", "nudge-fires.jsonl"), inboxDir = (world) => join(stateDir(), "inbox", safeComponent(world)), sessionDir = (sessionId) => join(stateDir(), "sessions", safeComponent(sessionId)), workerLockFile = () => join(stateDir(), "worker.lock"), hookSnapshotFile = () => join(stateDir(), "hook-config.json"), logFile = (name) => join(stateDir(), "logs", `${safeComponent(name)}.log`), worldDir = (world) => join(dataDir(), "worlds", safeComponent(world)), defaultTarget = (world) => join(worldDir(world), "learned"), builtinNudgesDir = () => join(pluginRoot(), "nudges"), SAFE_CHAR;
var init_paths = __esm(() => {
  SAFE_CHAR = /[\p{L}\p{N}._-]/u;
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
var ROTATE_AT_BYTES;
var init_fsx = __esm(() => {
  ROTATE_AT_BYTES = 10 * 1024 * 1024;
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
function appendLine(path, line, rotateAt = ROTATE_AT_BYTES2, keep = ROTATE_KEEP_LINES) {
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
  appendLine(fireLog, JSON.stringify(record));
}
var ROTATE_AT_BYTES2, ROTATE_KEEP_LINES = 5000, DEFAULT_STALE_MS = 2000, MIN_WAIT_MS = 200;
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
function validateGate(gate) {
  const problems = [];
  if (!isRecord(gate)) {
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
  if (!isRecord(gate))
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
var MAX_MATCH_LEN = 4000, MAX_PATTERN_LEN = 200, MAX_QUANTIFIED_GROUPS = 3, EVENTS, LOW_FREQUENCY_EVENTS, PREDICATES, RISKY_GROUP_BODY, BRACE_QUANTIFIER;
var init_gates = __esm(() => {
  EVENTS = {
    SessionStart: null,
    UserPromptSubmit: null,
    PreToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"]),
    PostToolUse: new Set(["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill"])
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
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function lintNudge(obj) {
  if (!isRecord2(obj))
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
  if (!isRecord2(obj["gate"]))
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

// packages/nudges/src/dispatch.ts
import { readdirSync } from "fs";
import { join as join3 } from "path";
function isRecord3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function loadNudgesDetailed(dirs) {
  const nudges = [];
  const rejected = [];
  for (const d of dirs) {
    let names;
    try {
      names = readdirSync(d).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join3(d, name);
      const raw = readJsonOr(file, null);
      if (!isRecord3(raw)) {
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
  }
  return { nudges, rejected };
}
function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function dispatch(payload, nudges, opts) {
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
      if (!isRecord3(nudge) || nudge["event"] !== event)
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
        writeBreadcrumb(opts.fireLog, opts.sessionDir, "gate_overrun", sessionId, event, {
          pattern,
          elapsed_ms: Math.round(elapsedMs),
          budget_ms: gateTimeoutMs
        });
      }
      if (!matched)
        continue;
      if (nudge["once_per"] !== "always") {
        if (!claimMarker(opts.sessionDir, `nudge-${pattern}`))
          continue;
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
var DEFAULT_BUDGET_MS = 250, DEFAULT_GATE_TIMEOUT_MS = 50, GATE_MIN_SLICE_MS = 5;
var init_dispatch = __esm(() => {
  init_fsx();
  init_firelog();
  init_gates();
  init_lint();
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
    appendLine(logFile("hook"), `${nowIso()} ${msg}`);
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

// apps/hook/src/snapshot.ts
import { readFileSync as readFileSync3 } from "fs";
function defaultWorld() {
  const target = defaultTarget("default");
  return {
    name: "default",
    repos: [],
    nudges_dir: `${target}/nudges`,
    rules_file: `${target}/RULES.md`,
    rules_inject: true
  };
}
function isRecord4(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str2(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
function defaultPluginRoot() {
  return process.env["CLAUDE_PLUGIN_ROOT"] ?? pluginRoot();
}
function coerceWorld(v) {
  if (!isRecord4(v))
    return null;
  const name = str2(v["name"], "");
  if (!name)
    return null;
  const repos = Array.isArray(v["repos"]) ? v["repos"].filter((r) => typeof r === "string") : [];
  return {
    name,
    repos,
    nudges_dir: str2(v["nudges_dir"], ""),
    rules_file: str2(v["rules_file"], ""),
    rules_inject: v["rules_inject"] !== false
  };
}
function coerceWorker(v) {
  if (!isRecord4(v))
    return { ...DEFAULT_WORKER };
  return {
    idle_minutes: num(v["idle_minutes"], DEFAULT_WORKER.idle_minutes),
    curriculum_interval_minutes: num(v["curriculum_interval_minutes"], DEFAULT_WORKER.curriculum_interval_minutes),
    min_tool_uses: num(v["min_tool_uses"], DEFAULT_WORKER.min_tool_uses),
    auto_kick: typeof v["auto_kick"] === "boolean" ? v["auto_kick"] : DEFAULT_WORKER.auto_kick
  };
}
function coerceSnapshot(obj) {
  const rawWorlds = Array.isArray(obj["worlds"]) ? obj["worlds"] : [];
  const worlds = rawWorlds.map(coerceWorld).filter((w) => w !== null);
  return {
    version: num(obj["version"], 1),
    worlds: worlds.length > 0 ? worlds : [defaultWorld()],
    worker: coerceWorker(obj["worker"]),
    plugin_root: str2(obj["plugin_root"], "") || defaultPluginRoot()
  };
}
function fallbackSnapshot() {
  return {
    version: 1,
    worlds: [defaultWorld()],
    worker: { ...DEFAULT_WORKER },
    plugin_root: defaultPluginRoot()
  };
}
function loadSnapshot() {
  try {
    const obj = JSON.parse(readFileSync3(hookSnapshotFile(), "utf8"));
    if (isRecord4(obj))
      return coerceSnapshot(obj);
  } catch {}
  return fallbackSnapshot();
}
var DEFAULT_WORKER;
var init_snapshot = __esm(() => {
  init_paths();
  DEFAULT_WORKER = {
    idle_minutes: 10,
    curriculum_interval_minutes: 60,
    min_tool_uses: 6,
    auto_kick: true
  };
});

// apps/hook/src/worlds.ts
import { realpathSync } from "fs";
import { isAbsolute, relative, resolve as resolve2 } from "path";
import { spawnSync } from "child_process";
function realOrResolve(p) {
  const abs = resolve2(expandHome2(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}
function expandHome2(p) {
  if (p === "~")
    return process.env["HOME"] ?? p;
  if (p.startsWith("~/"))
    return `${process.env["HOME"] ?? ""}${p.slice(1)}`;
  return p;
}
function isWithin(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || !rel.startsWith("..") && !isAbsolute(rel);
}
function cwdUnder(cwd, repo) {
  try {
    return isWithin(realOrResolve(cwd), realOrResolve(repo));
  } catch {
    return false;
  }
}
function resolveWorld(snapshot, cwd) {
  const worlds = snapshot.worlds ?? [];
  const target = realOrResolve(cwd);
  let best = null;
  let fallback = null;
  for (const w of worlds) {
    if (!w || typeof w !== "object")
      continue;
    const repos = w.repos ?? [];
    if (repos.length === 0 && fallback === null)
      fallback = w;
    for (const repo of repos) {
      const r = realOrResolve(repo);
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
  return defaultWorld();
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
  init_snapshot();
});

// apps/hook/src/lessons.ts
import { appendFileSync as appendFileSync3, mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, statSync as statSync3 } from "fs";
import { join as join4 } from "path";
function isRecord5(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function formatLesson(lesson) {
  return `Lesson (${lesson["pattern"] ?? ""}): ${lesson["text"] ?? ""}`;
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
      if (isRecord5(parsed))
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
    if (minMtime !== null) {
      try {
        if (statSync3(path).mtimeMs < minMtime)
          continue;
      } catch {
        continue;
      }
    }
    let parsed;
    try {
      parsed = JSON.parse(readFileSync4(path, "utf8"));
    } catch {
      continue;
    }
    if (!isRecord5(parsed))
      continue;
    const lid = typeof parsed["id"] === "string" ? parsed["id"] : parsed["id"] != null ? String(parsed["id"]) : "";
    if (!lid || already.has(lid))
      continue;
    const repo = parsed["repo"];
    if (typeof repo === "string" && repo && !cwdUnder(cwd, repo))
      continue;
    candidates.push({ obj: parsed, path });
  }
  candidates.sort((a, b) => {
    const ca = String(a.obj["created"] ?? "");
    const cb = String(b.obj["created"] ?? "");
    return ca < cb ? 1 : ca > cb ? -1 : 0;
  });
  const chosen = candidates.slice(0, limit);
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
  const start = text.indexOf(RULE_START);
  const end = text.indexOf(RULE_END);
  if (start === -1 || end === -1 || end <= start)
    return "";
  return text.slice(start + RULE_START.length, end).trim();
}
var LESSON_ARCHIVE_AT_DELIVERIES = 5, MAX_RULES_BYTES;
var init_lessons = __esm(() => {
  init_paths();
  init_consts();
  init_fsx();
  init_worlds();
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
import { mkdirSync as mkdirSync5, readFileSync as readFileSync6 } from "fs";
function isRecord6(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function queuePath(sessionId) {
  return `${queueDir("pending")}/${safeComponent(sessionId)}.json`;
}
function readQueueEntry(qpath) {
  try {
    const parsed = JSON.parse(readFileSync6(qpath, "utf8"));
    if (isRecord6(parsed))
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
function startGitHead(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync6(`${sessionDir(sessionId)}/start.json`, "utf8"));
    return isRecord6(parsed) ? str3(parsed["git_head"]) : null;
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
    if (!isRecord6(parsed))
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
function sessionLock(sessionId, fn) {
  const sdir = sessionDir(sessionId);
  mkdirSync5(sdir, { recursive: true });
  return withDirLock(`${sdir}/lock.lockdir`, fn);
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
function isRecord7(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assistantContent(record) {
  const message = record["message"];
  if (isRecord7(message) && Array.isArray(message["content"]))
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
    if (!isRecord7(record))
      continue;
    const rtype = record["type"];
    if (rtype === "attachment") {
      const attachmentRaw = record["attachment"];
      const attachment = isRecord7(attachmentRaw) ? attachmentRaw : {};
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
        if (isRecord7(block) && block["type"] === "tool_use")
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

// apps/hook/src/handlers.ts
import { appendFileSync as appendFileSync4, mkdirSync as mkdirSync6, readFileSync as readFileSync8, statSync as statSync6 } from "fs";
import { dirname as dirname4 } from "path";
function artifactRef(kind, name) {
  return `${kind}:${name}`;
}
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
function isRecord8(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function isDir(path) {
  try {
    return statSync6(path).isDirectory();
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
  return dispatchNudge(payload, world, sessionIdOf(payload));
}
function handlePostToolUse(payload, world) {
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  const toolName = payload["tool_name"];
  const toolInputRaw = payload["tool_input"];
  const toolInput = isRecord8(toolInputRaw) ? toolInputRaw : {};
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
  if (payload["stop_hook_active"] === true)
    return "";
  const sessionId = sessionIdOf(payload);
  const worldName = world.name || "default";
  sessionLock(sessionId, () => {
    upsertStopQueue(payload, worldName, sessionId);
    scanTranscript(payload, sessionId, (kind, ref, detail) => {
      appendUsageEvent(usageEventsFile(), { ts: nowIso(), session_id: sessionId, world: worldName, kind, ref, detail });
    });
  });
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
  markQueueEnded(payload, worldName, sessionId);
  return "";
}
function getHandler(event) {
  if (!Object.hasOwn(HANDLERS, event))
    return;
  return HANDLERS[event];
}
var usageFailureLogged = false, HANDLERS;
var init_handlers = __esm(async () => {
  init_paths();
  init_fsx();
  init_worlds();
  init_lessons();
  init_kick();
  await __promiseAll([
    init_src(),
    init_log(),
    init_queue(),
    init_scan()
  ]);
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
import { appendFileSync as appendFileSync5, mkdirSync as mkdirSync7 } from "fs";
import { homedir as homedir2 } from "os";
var OUTPUT_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
var SLOW_INVOCATION_MS = 150;
function expandHome3(p) {
  if (p === "~")
    return homedir2();
  if (p.startsWith("~/"))
    return `${homedir2()}${p.slice(1)}`;
  return p;
}
function fallbackStateDir() {
  const raw = process.env["SIL_STATE_DIR"];
  if (raw)
    return expandHome3(raw);
  const xdg = process.env["XDG_STATE_HOME"];
  const base = xdg ? expandHome3(xdg) : `${homedir2()}/.local/state`;
  return `${base}/self-improvement-loop`;
}
function fallbackLog(msg) {
  try {
    const dir = `${fallbackStateDir()}/logs`;
    mkdirSync7(dir, { recursive: true });
    appendFileSync5(`${dir}/hook.log`, `${new Date().toISOString()} ${msg}
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
    const world = resolveWorld(snapshot, cwd);
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
