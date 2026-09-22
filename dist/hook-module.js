// packages/core/src/samples.ts
var SAMPLED_INPUT_KEYS = ["command", "file_path"];
var SAMPLE_VALUE_MAX_CHARS = 500;
var SAMPLES_ROTATE_AT_BYTES = 2 * 1024 * 1024;
var CREDENTIAL_RE = /((?:authorization:\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+|(?:token|api[_-]?key|password|passwd|secret)=)['"]?)[^\s'"]+/gi;
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

// packages/core/src/spool.ts
var SPOOL_FILE_NAME = "module-spool.json";
function serializeSpool(spool) {
  return `${JSON.stringify(spool)}
`;
}

// apps/hook-module/src/io.ts
async function readText($, path) {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}
async function writeText($, path, text) {
  try {
    await $.fs.write(path, text);
    return true;
  } catch {
    return false;
  }
}
async function listDir($, path) {
  try {
    return await $.fs.list(path);
  } catch {
    return null;
  }
}
async function statPath($, path) {
  try {
    return await $.fs.stat(path);
  } catch {
    return null;
  }
}
async function pathExists($, path) {
  try {
    return await $.fs.exists(path);
  } catch {
    return false;
  }
}
async function readTextIfPresent($, path) {
  if (!await pathExists($, path))
    return null;
  return readText($, path);
}
async function listDirIfPresent($, path) {
  if (!await pathExists($, path))
    return null;
  return listDir($, path);
}
async function statPathIfPresent($, path) {
  if (!await pathExists($, path))
    return null;
  return statPath($, path);
}
async function runCommand($, argv, init) {
  try {
    return await $.process.run(argv, init);
  } catch {
    return null;
  }
}
async function readLayoutVars($) {
  const [silConfig, silState, silData, xdgConfig, xdgState, xdgData, home] = await Promise.all([
    $.env.get("SIL_CONFIG_DIR"),
    $.env.get("SIL_STATE_DIR"),
    $.env.get("SIL_DATA_DIR"),
    $.env.get("XDG_CONFIG_HOME"),
    $.env.get("XDG_STATE_HOME"),
    $.env.get("XDG_DATA_HOME"),
    $.env.get("HOME")
  ]);
  const vars = {};
  if (silConfig)
    vars["SIL_CONFIG_DIR"] = silConfig;
  if (silState)
    vars["SIL_STATE_DIR"] = silState;
  if (silData)
    vars["SIL_DATA_DIR"] = silData;
  if (xdgConfig)
    vars["XDG_CONFIG_HOME"] = xdgConfig;
  if (xdgState)
    vars["XDG_STATE_HOME"] = xdgState;
  if (xdgData)
    vars["XDG_DATA_HOME"] = xdgData;
  if (home)
    vars["HOME"] = home;
  return { vars, home: home ?? "" };
}
async function gitHead($, cwd) {
  const result = await runCommand($, ["git", "-C", cwd, "rev-parse", "HEAD"], { timeoutMs: 1000 });
  if (!result || result.exitCode !== 0)
    return null;
  const head = result.stdout.trim();
  return head || null;
}

// packages/core/src/layout.ts
var SLASH = 47;
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
function posixBasename(p) {
  let start = 0;
  let end = -1;
  let sawSlash = true;
  for (let i = p.length - 1;i >= 0; i--) {
    if (p.charCodeAt(i) === SLASH) {
      if (!sawSlash) {
        start = i + 1;
        break;
      }
    } else if (end === -1) {
      sawSlash = false;
      end = i + 1;
    }
  }
  return end === -1 ? "" : p.slice(start, end);
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
var SAFE_CHAR = /[\p{L}\p{N}._-]/u;
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

// packages/core/src/hook-snapshot.ts
var DEFAULT_WORKER = {
  idle_minutes: 10,
  curriculum_interval_minutes: 60,
  min_tool_uses: 6,
  auto_kick: true
};
function defaultWorldFor(defaultTarget) {
  return {
    name: "default",
    repos: [],
    nudges_dir: `${defaultTarget}/nudges`,
    rules_file: `${defaultTarget}/RULES.md`,
    rules_inject: true
  };
}
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
function coerceWorld(v) {
  if (!isRecord2(v))
    return null;
  const name = str(v["name"], "");
  if (!name)
    return null;
  const repos = Array.isArray(v["repos"]) ? v["repos"].filter((r) => typeof r === "string" && r !== "") : [];
  return {
    name,
    repos,
    nudges_dir: str(v["nudges_dir"], ""),
    rules_file: str(v["rules_file"], ""),
    rules_inject: v["rules_inject"] !== false
  };
}
function coerceWorker(v) {
  if (!isRecord2(v))
    return { ...DEFAULT_WORKER };
  return {
    idle_minutes: num(v["idle_minutes"], DEFAULT_WORKER.idle_minutes),
    curriculum_interval_minutes: num(v["curriculum_interval_minutes"], DEFAULT_WORKER.curriculum_interval_minutes),
    min_tool_uses: num(v["min_tool_uses"], DEFAULT_WORKER.min_tool_uses),
    auto_kick: typeof v["auto_kick"] === "boolean" ? v["auto_kick"] : DEFAULT_WORKER.auto_kick
  };
}
function coerceSnapshot(obj, defaults) {
  if (!isRecord2(obj)) {
    return { version: 1, worlds: [defaults.defaultWorld], worker: { ...DEFAULT_WORKER }, plugin_root: defaults.pluginRoot };
  }
  const rawWorlds = Array.isArray(obj["worlds"]) ? obj["worlds"] : [];
  const worlds = rawWorlds.map(coerceWorld).filter((w) => w !== null);
  return {
    version: num(obj["version"], 1),
    worlds: worlds.length > 0 ? worlds : [defaults.defaultWorld],
    worker: coerceWorker(obj["worker"]),
    plugin_root: str(obj["plugin_root"], "") || defaults.pluginRoot
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

// apps/hook-module/src/kick.ts
var WORKER_KICK_THROTTLE_MS = 15 * 60 * 1000;
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function workerRunning($, state) {
  const text = await readTextIfPresent($, state.layout.workerLockFile());
  if (text === null)
    return false;
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(pid))
    return false;
  const result = await runCommand($, ["kill", "-0", String(pid)]);
  if (!result)
    return false;
  if (result.exitCode === 0)
    return true;
  return result.stderr.toLowerCase().includes("permitted");
}
async function curriculumDueForAnyWorld($, state, intervalMinutes) {
  const intervalS = Number.isFinite(intervalMinutes) ? Math.max(intervalMinutes, 0) * 60 : DEFAULT_WORKER.curriculum_interval_minutes * 60;
  const worlds = state.snapshot.worlds?.length ? state.snapshot.worlds : [defaultWorldFor(state.layout.defaultTarget("default"))];
  const stateDir = state.layout.stateDir();
  for (const world of worlds) {
    if (!world || typeof world !== "object")
      continue;
    const marker = `${stateDir}/last-curriculum-${world.name || "default"}`;
    const st = await statPathIfPresent($, marker);
    if (!st)
      return true;
    if (Date.now() / 1000 - st.mtimeMs / 1000 >= intervalS)
      return true;
  }
  return false;
}
async function hasPendingWork($, state, workerCfg) {
  const pending = await listDirIfPresent($, state.layout.queueDir("pending"));
  if (pending && pending.length > 0)
    return true;
  const interval = workerCfg.curriculum_interval_minutes ?? DEFAULT_WORKER.curriculum_interval_minutes;
  return curriculumDueForAnyWorld($, state, interval);
}
async function maybeKickWorker($, state) {
  if (!state.snapshotPresent)
    return;
  const workerCfg = state.snapshot.worker ?? DEFAULT_WORKER;
  if (workerCfg.auto_kick === false)
    return;
  if (await workerRunning($, state))
    return;
  const lastKick = `${state.layout.stateDir()}/last-kick`;
  const st = await statPathIfPresent($, lastKick);
  if (st && Date.now() - st.mtimeMs < WORKER_KICK_THROTTLE_MS)
    return;
  if (!await hasPendingWork($, state, workerCfg))
    return;
  if (!await writeText($, lastKick, ""))
    return;
  const logPath = state.layout.logFile("worker");
  if (!await pathExists($, logPath))
    await writeText($, logPath, "");
  const built = `${state.pluginRoot}/dist/cli.js`;
  const bunCmd = await pathExists($, built) ? `bun ${shellQuote(built)} worker --once` : `bun run ${shellQuote(`${state.pluginRoot}/apps/cli/src/main.ts`)} worker --once`;
  await runCommand($, ["sh", "-c", `nohup ${bunCmd} >> ${shellQuote(logPath)} 2>&1 </dev/null &`], { cwd: state.pluginRoot });
}

// packages/core/src/consts.ts
var RULE_START = "<!--loop-rules:start-->";
var RULE_END = "<!--loop-rules:end-->";
var SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
var isSlug = (s) => SLUG_RE.test(s) && s.length <= 64;

// packages/core/src/lessons.ts
var LESSON_ARCHIVE_AT_DELIVERIES = 5;
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
function isRecord3(v) {
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
    if (!isRecord3(raw))
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

// apps/hook-module/src/state.ts
var SESSIONS = new Map;
function resetForTests() {
  SESSIONS.clear();
}
function nowIso() {
  return new Date().toISOString();
}
function pureReal(p, cwd, home) {
  const expanded = expandHomeWith(p, home);
  return expanded.startsWith("/") ? posixJoin(expanded) : posixJoin(cwd, expanded);
}
function realpathOf(state, p) {
  return state.realpaths.get(p) ?? pureReal(p, state.cwd, state.home);
}
function cwdUnderRepo(state, repo) {
  return cwdUnder(state.cwd, repo, (p) => realpathOf(state, p));
}
async function resolveRealpaths($, wanted, cwd, home) {
  const out = new Map;
  const unique = [...new Set(wanted.filter((p) => p))];
  if (unique.length === 0)
    return out;
  const result = await runCommand($, ["realpath", "-m", ...unique]);
  if (!result || result.exitCode !== 0)
    return out;
  const lines = result.stdout.split(`
`);
  if (lines[lines.length - 1] === "")
    lines.pop();
  if (lines.length !== unique.length)
    return out;
  for (let i = 0;i < unique.length; i++) {
    const key = unique[i];
    const value = lines[i];
    if (key && value)
      out.set(key, value);
  }
  return out;
}
function rootsAreAbsolute(l) {
  return [l.configDir(), l.stateDir(), l.dataDir()].every((root) => root.startsWith("/"));
}
async function initSession($, sessionId, cwd) {
  const { vars, home } = await readLayoutVars($);
  const l = layout({ get: (name) => Object.hasOwn(vars, name) ? vars[name] : undefined, home });
  if (!rootsAreAbsolute(l))
    return null;
  const pluginRoot = $.plugin.root;
  const fallbackWorld = defaultWorldFor(l.defaultTarget("default"));
  const sessionDir = l.sessionDir(sessionId);
  const markersDir = `${sessionDir}/nudge-markers`;
  const [snapshotText, entries] = await Promise.all([
    readTextIfPresent($, l.hookSnapshotFile()),
    listDirIfPresent($, markersDir)
  ]);
  let raw;
  if (snapshotText !== null) {
    try {
      raw = JSON.parse(snapshotText);
    } catch {}
  }
  const snapshot = coerceSnapshot(raw, { defaultWorld: fallbackWorld, pluginRoot });
  const wanted = [cwd];
  for (const w of snapshot.worlds) {
    for (const repo of w.repos)
      wanted.push(repo);
  }
  const realpaths = await resolveRealpaths($, wanted, cwd, home);
  const real = (p) => realpaths.get(p) ?? pureReal(p, cwd, home);
  const world = resolveWorld(snapshot, cwd, real, fallbackWorld);
  const markersOnDisk = new Set;
  for (const entry of entries ?? [])
    markersOnDisk.add(entry.name);
  return {
    sessionId,
    cwd,
    home,
    pluginRoot,
    layout: l,
    snapshot,
    snapshotPresent: snapshotText !== null,
    world,
    worldName: world.name || "default",
    sessionDir,
    markersDir,
    realpaths,
    delivered: new Set,
    claimed: new Set,
    markerSlugs: new Map,
    markersOnDisk,
    pendingMarkers: [],
    nudges: null,
    rejected: [],
    nudgeDirsMissing: false,
    startMtimeMs: null,
    appends: [],
    moves: [],
    inFlight: []
  };
}
async function ensureState($, sessionId, cwd) {
  const existing = SESSIONS.get(sessionId);
  if (existing)
    return existing;
  const state = await initSession($, sessionId, cwd);
  if (!state)
    return null;
  SESSIONS.set(sessionId, state);
  return state;
}
function peekState(sessionId) {
  return SESSIONS.get(sessionId);
}
function dropState(sessionId) {
  SESSIONS.delete(sessionId);
}
var MARKER_UNSAFE = /[^A-Za-z0-9_-]/g;
async function sha256Hex(raw) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  let hex = "";
  for (const byte of new Uint8Array(digest))
    hex += byte.toString(16).padStart(2, "0");
  return hex;
}
async function markerSlug(name) {
  const safe = name.replace(MARKER_UNSAFE, "_").slice(0, 64);
  const digest = await sha256Hex(name);
  return `${safe}-${digest.slice(0, 8)}`;
}
async function precomputeMarkers(state, names) {
  const missing = [...new Set(names.filter((n) => n && !state.markerSlugs.has(n)))];
  if (missing.length === 0)
    return;
  const slugs = await Promise.all(missing.map((n) => markerSlug(n)));
  for (let i = 0;i < missing.length; i++) {
    const name = missing[i];
    const slug = slugs[i];
    if (name && slug)
      state.markerSlugs.set(name, slug);
  }
}
function claimMarker(state, name) {
  if (state.claimed.has(name))
    return false;
  state.claimed.add(name);
  const slug = state.markerSlugs.get(name);
  if (slug === undefined)
    return true;
  if (state.markersOnDisk.has(slug))
    return false;
  state.markersOnDisk.add(slug);
  state.pendingMarkers.push(slug);
  return true;
}
async function flushMarkers($, state) {
  const pending = state.pendingMarkers.splice(0, state.pendingMarkers.length);
  for (const slug of pending)
    await writeText($, `${state.markersDir}/${slug}`, "");
}
function spoolAppend(state, target, line) {
  state.appends.push({ target, line });
}
function spoolMove(state, from, to) {
  state.moves.push({ from, to });
}
function takeSpool(state) {
  if (state.appends.length === 0 && state.moves.length === 0)
    return null;
  const flight = { appends: state.appends, moves: state.moves };
  state.appends = [];
  state.moves = [];
  state.inFlight.push(flight);
  return flight;
}
function settleSpool(state, flight, applied) {
  const index = state.inFlight.indexOf(flight);
  if (index >= 0)
    state.inFlight.splice(index, 1);
  if (applied)
    return;
  state.appends.unshift(...flight.appends);
  state.moves.unshift(...flight.moves);
}
function spoolHookRun(state, event, durationMs, error) {
  const detail = { exitCode: 0, durationMs: Number(durationMs.toFixed(1)), hookEvent: event };
  if (error)
    detail["error"] = error;
  spoolAppend(state, { kind: "hook-runs" }, JSON.stringify({
    ts: nowIso(),
    session_id: state.sessionId,
    world: state.worldName,
    kind: "hook_run",
    ref: `hook:module:${event}`,
    detail
  }));
}
function errorSummary(e) {
  const name = e instanceof Error ? e.constructor.name : "Error";
  const message = e instanceof Error ? e.message : String(e);
  return `${name}: ${message.slice(0, 120)}`;
}

// apps/hook-module/src/lessons.ts
var MAX_RULES_BYTES = 256 * 1024;
var RULE_TAG_RE = /<!--\s*rule:([A-Za-z0-9._-]+)\s*-->/g;
async function rulesBlock($, state) {
  if (state.world.rules_inject === false)
    return "";
  const rulesFile = state.world.rules_file;
  if (!rulesFile)
    return "";
  const st = await statPathIfPresent($, rulesFile);
  if (!st || st.kind !== "file" || st.size > MAX_RULES_BYTES)
    return "";
  const text = await readText($, rulesFile);
  if (text === null)
    return "";
  return rulesBlockFrom(text);
}
async function recordRuleUses($, state, rulesText) {
  const slugs = [...new Set([...rulesText.matchAll(RULE_TAG_RE)].map((m) => m[1] ?? ""))].filter((s) => s);
  if (slugs.length === 0)
    return;
  await precomputeMarkers(state, slugs.map((s) => `rule-use-${s}`));
  for (const slug of slugs) {
    if (!claimMarker(state, `rule-use-${slug}`))
      continue;
    spoolAppend(state, { kind: "usage-events" }, JSON.stringify({
      ts: nowIso(),
      session_id: state.sessionId,
      world: state.worldName,
      kind: "rule",
      ref: `rule:${slug}`,
      detail: {}
    }));
  }
  await flushMarkers($, state);
}
async function sessionStartMtime($, state) {
  if (state.startMtimeMs !== null)
    return state.startMtimeMs;
  const start = await statPathIfPresent($, `${state.sessionDir}/start.json`);
  if (start) {
    state.startMtimeMs = start.mtimeMs;
    return start.mtimeMs;
  }
  const dir = await statPathIfPresent($, state.sessionDir);
  return dir ? dir.mtimeMs : null;
}
async function deliverLessons($, state, limit, minMtime) {
  const inbox = state.layout.inboxDir(state.worldName);
  const entries = await listDirIfPresent($, inbox);
  if (entries === null)
    return [];
  const names = entries.map((entry) => entry.name).filter((name) => name.endsWith(".json")).sort();
  const already = new Set(state.delivered);
  const deliveredText = await readTextIfPresent($, `${state.sessionDir}/delivered`);
  if (deliveredText !== null) {
    for (const line of deliveredText.split(`
`)) {
      const trimmed = line.trim();
      if (trimmed)
        already.add(trimmed);
    }
  }
  const candidates = [];
  for (const name of names) {
    const stem = name.slice(0, -".json".length);
    if (already.has(stem))
      continue;
    const path = posixJoin(inbox, name);
    let mtimeMs = 0;
    if (minMtime !== null) {
      const st = await statPath($, path);
      if (!st)
        continue;
      mtimeMs = st.mtimeMs;
      if (mtimeMs < minMtime)
        continue;
    }
    const body = await readText($, path);
    let raw;
    if (body !== null) {
      try {
        raw = JSON.parse(body);
      } catch {}
    }
    candidates.push({ path, stem, mtimeMs, raw });
  }
  const chosen = selectLessons(candidates, already, (repo) => cwdUnderRepo(state, repo), limit, minMtime);
  for (const { obj, path } of chosen) {
    state.delivered.add(String(obj["id"]));
    spoolAppend(state, { kind: "session-file", name: "delivered" }, String(obj["id"]));
    const deliveries = (typeof obj["deliveries"] === "number" ? obj["deliveries"] : 0) + 1;
    obj["deliveries"] = deliveries;
    await writeText($, path, `${JSON.stringify(obj, null, 2)}
`);
    if (deliveries >= LESSON_ARCHIVE_AT_DELIVERIES) {
      spoolMove(state, path, posixJoin(inbox, "archive", posixBasename(path)));
    }
  }
  return chosen.map((c) => formatLesson(c.obj));
}

// packages/nudges/src/gates.ts
var MAX_MATCH_LEN = 4000;
var MAX_PATTERN_LEN = 200;
var MAX_QUANTIFIED_GROUPS = 3;
var TOOL_MATCHERS = ["Bash", "Edit", "Write", "Read", "Grep", "Glob", "Agent", "Skill", "ToolSearch", "WebFetch", "WebSearch", "NotebookEdit"];
var EVENTS = {
  SessionStart: null,
  UserPromptSubmit: null,
  PreToolUse: new Set(TOOL_MATCHERS),
  PostToolUse: new Set(TOOL_MATCHERS)
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
var RISKY_GROUP_BODY = /[|+*?{]/;
var BRACE_QUANTIFIER = /^\{\d+(?:,\d*)?\}/;
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
function isRecord4(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function command(payload) {
  const ti = payload["tool_input"];
  return isRecord4(ti) && typeof ti["command"] === "string" ? ti["command"] : "";
}
function filePath(payload) {
  const ti = payload["tool_input"];
  return isRecord4(ti) && typeof ti["file_path"] === "string" ? ti["file_path"] : "";
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
  if (!isRecord4(gate))
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
  if (!isRecord4(gate)) {
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
  if (!isRecord4(gate))
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

// packages/nudges/src/lint.ts
var MAX_TEXT = 400;
var ONCE_PER = new Set(["session", "always"]);
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
function isRecord5(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function lintNudge(obj) {
  if (!isRecord5(obj))
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
  if (!isRecord5(obj["gate"]))
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

// packages/nudges/src/dispatch-core.ts
var DEFAULT_BUDGET_MS = 250;
var DEFAULT_GATE_TIMEOUT_MS = 50;
var GATE_MIN_SLICE_MS = 5;
function isRecord6(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function str2(v, fallback = "") {
  return typeof v === "string" ? v : fallback;
}
function breadcrumb(sink, kind, sessionId, event, extra) {
  if (!sink.claimMarker(`breadcrumb-${kind}-${event}`))
    return;
  sink.breadcrumb({ ts: new Date().toISOString(), kind, session_id: sessionId, event, ...extra });
}
function dispatchWith(payload, nudges, sink, opts = {}) {
  try {
    const sessionId = str2(payload["session_id"], "unknown");
    const event = str2(payload["hook_event_name"]);
    const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
    const gateTimeoutMs = opts.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    let gateSpentMs = 0;
    let scanned = 0;
    let budgetExhausted = false;
    for (const nudge of nudges) {
      scanned++;
      if (!isRecord6(nudge) || nudge["event"] !== event)
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
      const pattern = str2(nudge["pattern"], "unknown");
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
      return str2(nudge["text"]);
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
    if (!isRecord6(raw)) {
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

// apps/hook-module/src/nudges.ts
var HANDLED_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"];
var BREADCRUMB_KINDS = ["nudge_dir_missing", "gate_overrun", "gate_budget_exhausted"];
async function loadNudges($, state) {
  if (state.nudges !== null)
    return;
  const worldDir = state.world.nudges_dir;
  const dirs = typeof worldDir === "string" && worldDir.trim() ? [worldDir] : [];
  dirs.push(`${state.pluginRoot}/nudges`);
  const files = [];
  let anyDir = false;
  for (const dir of dirs) {
    const entries = await listDirIfPresent($, dir);
    if (entries === null)
      continue;
    anyDir = true;
    const names = entries.map((entry) => entry.name).filter((name) => name.endsWith(".json")).sort();
    for (const name of names) {
      const file = posixJoin(dir, name);
      const text = await readText($, file);
      let raw = null;
      if (text !== null) {
        try {
          raw = JSON.parse(text);
        } catch {}
      }
      files.push({ file, raw });
    }
  }
  const loaded = lintLoadedNudges(files);
  state.nudges = loaded.nudges;
  state.rejected = loaded.rejected;
  state.nudgeDirsMissing = !anyDir;
  const markerNames = [];
  for (const nudge of loaded.nudges)
    markerNames.push(`nudge-${nudge.pattern}`);
  for (const rejected of loaded.rejected)
    markerNames.push(`breadcrumb-nudge_invalid-${rejected.file}`);
  for (const kind of BREADCRUMB_KINDS) {
    for (const event of HANDLED_EVENTS)
      markerNames.push(`breadcrumb-${kind}-${event}`);
  }
  await precomputeMarkers(state, markerNames);
}
function breadcrumb2(state, kind, event, extra, dedupeKey) {
  if (!claimMarker(state, `breadcrumb-${dedupeKey ?? `${kind}-${event}`}`))
    return;
  spoolAppend(state, { kind: "nudge-fires" }, JSON.stringify({ ts: nowIso(), kind, session_id: state.sessionId, event, ...extra }));
}
async function dispatchNudges($, state, payload) {
  await loadNudges($, state);
  const event = typeof payload["hook_event_name"] === "string" ? payload["hook_event_name"] : "";
  if (state.nudgeDirsMissing)
    breadcrumb2(state, "nudge_dir_missing", event, {});
  for (const rejected of state.rejected) {
    breadcrumb2(state, "nudge_invalid", event, { file: rejected.file, problems: rejected.problems.slice(0, 3) }, `nudge_invalid-${rejected.file}`);
  }
  const sink = {
    claimMarker: (name) => claimMarker(state, name),
    fire: (record) => spoolAppend(state, { kind: "nudge-fires" }, JSON.stringify(record)),
    breadcrumb: (record) => spoolAppend(state, { kind: "nudge-fires" }, JSON.stringify(record))
  };
  const text = dispatchWith(payload, state.nudges ?? [], sink) ?? "";
  await flushMarkers($, state);
  return text;
}

// apps/hook-module/src/register.ts
function resetForTests2() {
  resetForTests();
  guardPid = null;
  guardPidResolved = false;
}
var STATUS_LINE = "self-improvement-loop is active: /reflect queues this session for " + "background reflection, /loop shows status, /feedback <type>:<name> " + "good|bad rates an artifact.";
var guardPid = null;
var guardPidResolved = false;
var PID_RE = /^[1-9][0-9]*$/;
async function hookModuleGuard($) {
  if (guardPidResolved)
    return guardPid;
  guardPidResolved = true;
  const result = await runCommand($, ["sh", "-c", "echo $PPID"], { timeoutMs: 1000 });
  if (!result || result.exitCode !== 0)
    return null;
  const pid = result.stdout.trim();
  if (PID_RE.test(pid))
    guardPid = pid;
  return guardPid;
}
function isRecord7(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
async function identify($, sessionId, cwd) {
  let engineId = "";
  try {
    engineId = await $.session.id();
  } catch {}
  const dir = cwd || await $.session.cwd();
  return { sessionId: engineId || sessionId, cwd: dir };
}
function payloadOf(e, state) {
  const source = isRecord7(e) ? e : {};
  return { ...source, session_id: state.sessionId, cwd: state.cwd };
}
function spoolPath(state) {
  return `${state.sessionDir}/${SPOOL_FILE_NAME}`;
}
async function writeSpool($, state) {
  if (!state)
    return null;
  const flight = takeSpool(state);
  if (!flight)
    return null;
  const wrote = await writeText($, spoolPath(state), serializeSpool({
    version: 1,
    session_id: state.sessionId,
    written_at: nowIso(),
    appends: flight.appends,
    moves: flight.moves
  }));
  if (!wrote) {
    settleSpool(state, flight, false);
    return null;
  }
  return flight;
}
async function settleAfterChain($, state, flight) {
  if (!state || !flight)
    return;
  settleSpool(state, flight, !await pathExists($, spoolPath(state)));
}
async function stateToFlush($, sessionId) {
  let engineId = "";
  try {
    engineId = await $.session.id();
  } catch {}
  return peekState(engineId) ?? peekState(sessionId) ?? null;
}
async function writeStartJson($, state, head) {
  const written = await writeText($, `${state.sessionDir}/start.json`, `${JSON.stringify({ ts: nowIso(), cwd: state.cwd, world: state.worldName, git_head: head }, null, 2)}
`);
  if (written)
    state.startMtimeMs = Date.now();
}
function register(on) {
  on("classic.SessionStart", async ($, e, next) => {
    const started = performance.now();
    const errors = [];
    let state = null;
    let text = "";
    const guardPending = hookModuleGuard($);
    try {
      const who = await identify($, e.session_id, e.cwd);
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }
    if (state) {
      const parts = [];
      let rulesText = "";
      const headPending = gitHead($, state.cwd);
      try {
        rulesText = await rulesBlock($, state);
        if (rulesText)
          parts.push(`Promoted rules for world ${state.worldName}:
${rulesText}`);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        const lessons = await deliverLessons($, state, 3, null);
        if (lessons.length > 0)
          parts.push(lessons.join(`
`));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      parts.push(STATUS_LINE);
      try {
        const nudgeText = await dispatchNudges($, state, payloadOf(e, state));
        if (nudgeText)
          parts.push(nudgeText);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        if (rulesText)
          await recordRuleUses($, state, rulesText);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        await writeStartJson($, state, await headPending);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        await maybeKickWorker($, state);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      text = parts.filter((p) => p).join(`

`);
    }
    try {
      const guard = await guardPending;
      if (state && guard)
        await $.env.set("SIL_HOOK_MODULE", guard);
    } catch (err) {
      errors.push(errorSummary(err));
    }
    if (state)
      spoolHookRun(state, "SessionStart", performance.now() - started, errors[0]);
    const r = await next(e);
    return text ? { ...r, additionalContext: [...r.additionalContext ?? [], text] } : r;
  });
  on("classic.UserPromptSubmit", async ($, e, next) => {
    const started = performance.now();
    const errors = [];
    let state = null;
    let text = "";
    try {
      const who = await identify($, e.session_id, e.cwd);
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }
    if (state) {
      const parts = [];
      try {
        const minMtime = await sessionStartMtime($, state);
        const lessons = minMtime === null ? [] : await deliverLessons($, state, 2, minMtime);
        if (lessons.length > 0)
          parts.push(lessons.join(`
`));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        const nudgeText = await dispatchNudges($, state, payloadOf(e, state));
        if (nudgeText)
          parts.push(nudgeText);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      text = parts.filter((p) => p).join(`

`);
      spoolHookRun(state, "UserPromptSubmit", performance.now() - started, errors[0]);
    }
    const r = await next(e);
    return text ? { ...r, additionalContext: [...r.additionalContext ?? [], text] } : r;
  });
  on("classic.PreToolUse", async ($, e, next) => {
    const started = performance.now();
    const errors = [];
    let state = null;
    let text = "";
    try {
      const who = await identify($, "", "");
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }
    if (state) {
      const toolInput = {};
      let toolName = "";
      let toolUseId = "";
      for (const [key, value] of Object.entries(e)) {
        if (key === "tool") {
          toolName = typeof value === "string" ? value : "";
          continue;
        }
        if (key === "tool_use_id") {
          toolUseId = typeof value === "string" ? value : "";
          continue;
        }
        if (key === "agentId")
          continue;
        toolInput[key] = value;
      }
      const payload = {
        hook_event_name: "PreToolUse",
        session_id: state.sessionId,
        cwd: state.cwd,
        tool_name: toolName,
        tool_use_id: toolUseId,
        tool_input: toolInput
      };
      try {
        const record = sampleRecord(payload, nowIso());
        if (record)
          spoolAppend(state, { kind: "payload-samples", world: state.worldName }, JSON.stringify(record));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        text = await dispatchNudges($, state, payload);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      spoolHookRun(state, "PreToolUse", performance.now() - started, errors[0]);
    }
    const r = await next(e);
    return text ? { ...r, additionalContext: [...r.additionalContext ?? [], text] } : r;
  });
  on("classic.PostToolUse", async ($, e, next) => {
    const started = performance.now();
    const errors = [];
    let state = null;
    let text = "";
    try {
      const who = await identify($, e.session_id, e.cwd);
      state = await ensureState($, who.sessionId, who.cwd);
    } catch (err) {
      errors.push(errorSummary(err));
    }
    if (state) {
      try {
        recordToolUsage(state, e.tool_name, e.tool_input);
      } catch (err) {
        errors.push(errorSummary(err));
      }
      try {
        text = await dispatchNudges($, state, payloadOf(e, state));
      } catch (err) {
        errors.push(errorSummary(err));
      }
      spoolHookRun(state, "PostToolUse", performance.now() - started, errors[0]);
    }
    const r = await next(e);
    return text ? { ...r, additionalContext: [...r.additionalContext ?? [], text] } : r;
  });
  on("classic.Stop", async ($, e, next) => {
    let state = null;
    let flight = null;
    try {
      state = await stateToFlush($, e.session_id);
      flight = await writeSpool($, state);
    } catch {}
    const r = await next(e);
    try {
      await settleAfterChain($, state, flight);
    } catch {
      if (state && flight)
        settleSpool(state, flight, false);
    }
    return r;
  });
  on("classic.SessionEnd", async ($, e, next) => {
    let state = null;
    let flight = null;
    try {
      state = await stateToFlush($, e.session_id);
      flight = await writeSpool($, state);
    } catch {}
    const r = await next(e);
    try {
      await settleAfterChain($, state, flight);
    } catch {
      if (state && flight)
        settleSpool(state, flight, false);
    }
    return r;
  });
  on("session.end", async ($, e, next) => {
    let state = null;
    try {
      state = await stateToFlush($, e.sessionId);
      await writeSpool($, state);
    } catch {}
    const r = await next(e);
    if (state)
      dropState(state.sessionId);
    return r;
  });
}
function recordToolUsage(state, toolName, rawInput) {
  const toolInput = isRecord7(rawInput) ? rawInput : {};
  if (toolName === "Skill") {
    spoolAppend(state, { kind: "usage-events" }, JSON.stringify({
      ts: nowIso(),
      session_id: state.sessionId,
      world: state.worldName,
      kind: "skill",
      ref: `skill:${String(toolInput["skill"] ?? "")}`,
      detail: {}
    }));
  } else if (toolName === "Agent") {
    spoolAppend(state, { kind: "usage-events" }, JSON.stringify({
      ts: nowIso(),
      session_id: state.sessionId,
      world: state.worldName,
      kind: "agent",
      ref: `agent:${String(toolInput["subagent_type"] ?? "")}`,
      detail: { model: toolInput["model"] ?? null }
    }));
  }
}
export {
  register,
  resetForTests2 as resetForTests
};
