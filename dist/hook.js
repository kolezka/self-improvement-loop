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
import { homedir } from "os";
import { join, resolve } from "path";
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
function pluginRoot() {
  const raw = process.env["CLAUDE_PLUGIN_ROOT"];
  if (raw)
    return raw;
  return resolve(import.meta.dir, "..", "..", "..");
}
function safeComponent(name) {
  const cleaned = Array.from(name, (c) => /[A-Za-z0-9._-]/.test(c) ? c : "_").join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}
var queueDir = (bucket) => join(stateDir(), "queue", bucket), usageEventsFile = () => join(stateDir(), "usage", "events.jsonl"), nudgeFiresFile = () => join(stateDir(), "usage", "nudge-fires.jsonl"), inboxDir = (world) => join(stateDir(), "inbox", safeComponent(world)), sessionDir = (sessionId) => join(stateDir(), "sessions", safeComponent(sessionId)), workerLockFile = () => join(stateDir(), "worker.lock"), hookSnapshotFile = () => join(stateDir(), "hook-config.json"), logFile = (name) => join(stateDir(), "logs", `${safeComponent(name)}.log`), worldDir = (world) => join(dataDir(), "worlds", safeComponent(world)), defaultTarget = (world) => join(worldDir(world), "learned"), builtinNudgesDir = () => join(pluginRoot(), "nudges");
var init_paths = () => {};

// packages/core/src/fsx.ts
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs";
import { dirname, join as join2 } from "path";
function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}
function atomicWrite(path, text) {
  ensureDir(dirname(path));
  const tmp = join2(dirname(path), `.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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
import { appendFileSync as appendFileSync2, existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync as readFileSync2, rmSync, statSync as statSync2, writeFileSync as writeFileSync2 } from "fs";
import { dirname as dirname2 } from "path";
function withDirLock(lockDir, fn, staleMs = 5000) {
  const giveUpAt = Date.now() + Math.max(staleMs * 4, 2000);
  for (;; ) {
    try {
      mkdirSync2(lockDir);
      break;
    } catch (e) {
      if (e.code !== "EEXIST")
        throw e;
      try {
        const age = Date.now() - statSync2(lockDir).mtimeMs;
        if (age > staleMs) {
          rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      if (Date.now() > giveUpAt)
        throw new Error(`withDirLock: timed out waiting for ${lockDir}`);
      Bun.sleepSync(5);
    }
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
    mkdirSync2(dirname2(path), { recursive: true });
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
    if (existsSync2(mark))
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
function writeBreadcrumb(fireLog, sessionDir, kind, sessionId, event, extra = {}) {
  if (!claimMarker(sessionDir, `breadcrumb-${kind}-${event}`))
    return;
  const record = { ts: ts(), kind, session_id: sessionId, event, ...extra };
  appendLine(fireLog, JSON.stringify(record));
}
var ROTATE_AT_BYTES2, ROTATE_KEEP_LINES = 5000;
var init_firelog = __esm(() => {
  init_fsx();
  ROTATE_AT_BYTES2 = 10 * 1024 * 1024;
});

// packages/nudges/src/gates.ts
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
var MAX_MATCH_LEN = 4000, EVENTS, LOW_FREQUENCY_EVENTS, PREDICATES;
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
});

// packages/nudges/src/dispatch.ts
import { readdirSync } from "fs";
import { join as join3 } from "path";
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function loadNudges(dirs) {
  const out = [];
  for (const d of dirs) {
    let names;
    try {
      names = readdirSync(d).filter((n) => n.endsWith(".json")).sort();
    } catch {
      continue;
    }
    for (const name of names) {
      const raw = readJsonOr(join3(d, name), null);
      if (isRecord2(raw))
        out.push(raw);
    }
  }
  return out;
}
function str(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function dispatch(payload, nudges, opts) {
  try {
    const sessionId = str(payload["session_id"], "unknown");
    const event = str(payload["hook_event_name"]);
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    let gateSpentMs = 0;
    let scanned = 0;
    let budgetExhausted = false;
    for (const nudge of nudges) {
      scanned++;
      if (!isRecord2(nudge) || nudge["event"] !== event)
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
      gateSpentMs += performance.now() - started;
      if (!matched)
        continue;
      const pattern = str(nudge["pattern"], "unknown");
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
var DEFAULT_BUDGET_MS = 250, GATE_MIN_SLICE_MS = 5;
var init_dispatch = __esm(() => {
  init_fsx();
  init_firelog();
  init_gates();
});

// packages/core/src/consts.ts
var RULE_START = "<!--loop-rules:start-->", RULE_END = "<!--loop-rules:end-->";
var init_consts = () => {};

// packages/nudges/src/lint.ts
var ONCE_PER;
var init_lint = __esm(() => {
  init_consts();
  init_gates();
  ONCE_PER = new Set(["session", "always"]);
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
function isRecord3(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function fallbackSnapshot() {
  return {
    version: 1,
    worlds: [defaultWorld()],
    worker: { ...DEFAULT_WORKER },
    plugin_root: process.env["CLAUDE_PLUGIN_ROOT"] ?? pluginRoot()
  };
}
function loadSnapshot() {
  try {
    const obj = JSON.parse(readFileSync3(hookSnapshotFile(), "utf8"));
    if (isRecord3(obj))
      return obj;
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
import { appendFileSync as appendFileSync3, existsSync as existsSync3, mkdirSync as mkdirSync3, readdirSync as readdirSync2, readFileSync as readFileSync4, renameSync as renameSync2, statSync as statSync3 } from "fs";
import { join as join4 } from "path";
function isRecord4(v) {
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
      if (isRecord4(parsed))
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
  try {
    return statSync3(join4(sessionDir(sessionId), "start.json")).mtimeMs;
  } catch {
    return null;
  }
}
function pendingLessons(worldName, sessionId, cwd, limit, sinceSessionStart = false) {
  const inbox = inboxDir(worldName);
  let names;
  try {
    names = readdirSync2(inbox).filter((n) => n.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const deliveredFile = join4(sessionDir(sessionId), "delivered");
  const already = readDelivered(deliveredFile);
  const minMtime = sinceSessionStart ? sessionStartMtime(sessionId) : null;
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
    if (!isRecord4(parsed))
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
  if (!rulesFile || !existsSync3(rulesFile))
    return "";
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
var LESSON_ARCHIVE_AT_DELIVERIES = 5;
var init_lessons = __esm(() => {
  init_paths();
  init_consts();
  init_fsx();
  init_worlds();
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
function spawnLogPath() {
  return spawnLogOverride ?? process.env["SIL_TEST_SPAWN_LOG"] ?? null;
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
  const testLog = spawnLogPath();
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
function isRecord5(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function queuePath(sessionId) {
  return `${queueDir("pending")}/${safeComponent(sessionId)}.json`;
}
function readQueueEntry(qpath) {
  try {
    const parsed = JSON.parse(readFileSync6(qpath, "utf8"));
    if (isRecord5(parsed))
      return parsed;
  } catch {}
  return {};
}
function writeQueueEntry(qpath, entry) {
  atomicWrite(qpath, `${JSON.stringify(entry, null, 2)}
`);
}
function str2(v) {
  return typeof v === "string" ? v : null;
}
function truthyStr(v) {
  return typeof v === "string" && v !== "" ? v : null;
}
function startGitHead(sessionId) {
  try {
    const parsed = JSON.parse(readFileSync6(`${sessionDir(sessionId)}/start.json`, "utf8"));
    return isRecord5(parsed) ? str2(parsed["git_head"]) : null;
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
    result: str2(existing["result"])
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
    if (!isRecord5(parsed))
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
    transcript_path: str2(payload["transcript_path"]),
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
function isRecord6(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function assistantContent(record) {
  const message = record["message"];
  if (isRecord6(message) && Array.isArray(message["content"]))
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
    if (!isRecord6(record))
      continue;
    const rtype = record["type"];
    if (rtype === "attachment") {
      const attachmentRaw = record["attachment"];
      const attachment = isRecord6(attachmentRaw) ? attachmentRaw : {};
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
        if (isRecord6(block) && block["type"] === "tool_use")
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
import { dirname as dirname3 } from "path";
function artifactRef(kind, name) {
  return `${kind}:${name}`;
}
function appendUsageEvent(path, event) {
  try {
    mkdirSync6(dirname3(path), { recursive: true });
    appendFileSync4(path, `${JSON.stringify(event)}
`, { encoding: "utf8", flag: "a" });
  } catch (e) {
    if (usageFailureLogged)
      return;
    usageFailureLogged = true;
    log(`usage.append_event failed for ${path}: ${e.message}`);
  }
}
function isRecord7(v) {
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
  const nudges = loadNudges(dirs);
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
  writeStartJson(sessionId, { ts: nowIso(), cwd: String(cwd), world: worldName, git_head: gitHead(cwd) });
  maybeKickWorker(snapshot);
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
  const toolInput = isRecord7(toolInputRaw) ? toolInputRaw : {};
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
      detail: { model: toolInput["model"] ?? null, description: toolInput["description"] ?? null }
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
