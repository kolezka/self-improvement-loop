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
    reflectRunsFile: () => posixJoin(stateDir(), "usage", "reflect-runs.jsonl"),
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
var SESSION_START_ACTIVE_LINE = "self-improvement-loop is active: /reflect queues this session for " + "background reflection, /loop shows status, /feedback <type>:<name> " + "good|bad rates an artifact.";
function notInitializedLine(pluginRoot) {
  const sil = pluginRoot ? `"${pluginRoot}/scripts/sil"` : '"${CLAUDE_PLUGIN_ROOT}/scripts/sil"';
  return `self-improvement-loop is installed but not set up yet. Run ${sil} init to turn it on. ` + "Sessions are not reflected until then.";
}
function sessionStartStatusLine(snapshotPresent, pluginRoot) {
  return snapshotPresent ? SESSION_START_ACTIVE_LINE : notInitializedLine(pluginRoot);
}
function defaultWorldFor(defaultTarget) {
  return {
    name: "default",
    repos: [],
    nudges_dir: `${defaultTarget}/nudges`,
    rules_file: `${defaultTarget}/RULES.md`,
    rules_inject: true
  };
}
function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function num(v, fallback) {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
function str(v, fallback) {
  return typeof v === "string" ? v : fallback;
}
function coerceWorld(v) {
  if (!isRecord(v))
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
  if (!isRecord(v))
    return { ...DEFAULT_WORKER };
  return {
    idle_minutes: num(v["idle_minutes"], DEFAULT_WORKER.idle_minutes),
    curriculum_interval_minutes: num(v["curriculum_interval_minutes"], DEFAULT_WORKER.curriculum_interval_minutes),
    min_tool_uses: num(v["min_tool_uses"], DEFAULT_WORKER.min_tool_uses),
    auto_kick: typeof v["auto_kick"] === "boolean" ? v["auto_kick"] : DEFAULT_WORKER.auto_kick
  };
}
function coerceSnapshot(obj, defaults) {
  if (!isRecord(obj)) {
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

// packages/core/src/samples.ts
var SAMPLED_INPUT_KEYS = ["command", "file_path"];
var SAMPLE_VALUE_MAX_CHARS = 500;
var SAMPLES_ROTATE_AT_BYTES = 2 * 1024 * 1024;
var CREDENTIAL_RE = /((?:authorization:\s*(?:(?:bearer|basic|token)\s+)?|bearer\s+|(?:token|api[_-]?key|password|passwd|secret)=)['"]?)[^\s'"]+/gi;
function redactCredentials(text) {
  return text.replace(CREDENTIAL_RE, "$1<redacted>");
}
function isRecord2(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function sampleRecord(payload, ts) {
  const toolName = payload["tool_name"];
  if (typeof toolName !== "string" || !toolName)
    return null;
  const rawInput = payload["tool_input"];
  const toolInput = {};
  if (isRecord2(rawInput)) {
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
var WORLD_NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u;

// packages/core/src/lessons.ts
var LESSON_ARCHIVE_AT_DELIVERIES = 5;
var MAX_RULES_BYTES = 256 * 1024;
function formatLesson(lesson) {
  return `Lesson (${lesson["pattern"] ?? ""}): ${lesson["text"] ?? ""}`;
}
function rulesInjectable(world, stat) {
  if (world.rules_inject === false)
    return false;
  if (!world.rules_file)
    return false;
  if (!stat || !stat.isFile)
    return false;
  return stat.size <= MAX_RULES_BYTES;
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
var RULE_TAG_RE = /<!--\s*rule:([A-Za-z0-9._-]+)\s*-->/g;
async function rulesBlock($, state) {
  const rulesFile = state.world.rules_file;
  if (state.world.rules_inject === false || !rulesFile)
    return "";
  const st = await statPathIfPresent($, rulesFile);
  if (!rulesInjectable(state.world, st ? { isFile: st.kind === "file", size: st.size } : null))
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
var MCP_TOOL_MATCHER_RE = /^mcp__[A-Za-z0-9_-]{1,64}__[A-Za-z0-9_.-]{1,128}$/;
function matcherAllowed(event, matcher) {
  if (!Object.hasOwn(EVENTS, event))
    return false;
  const allowed = EVENTS[event];
  if (allowed === null || allowed === undefined)
    return false;
  return allowed.has(matcher) || MCP_TOOL_MATCHER_RE.test(matcher);
}
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
  if (!matcher)
    return [event, null];
  if (!matcherAllowed(event, matcher))
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
function triggerMatches(payload, event, matcher) {
  if (event !== str2(payload["hook_event_name"]))
    return false;
  if (matcher && payload["tool_name"] !== matcher)
    return false;
  return true;
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
      if (!isRecord6(nudge) || !triggerMatches(payload, nudge["event"], nudge["matcher"]))
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

// packages/core/src/lesson-curation.ts
var MAX_TEXT_BYTES = 4000;
var MAX_QUOTE_BYTES = 4000;
var MAX_REFERENCE_BYTES = 1000;
var MAX_MUTATION_BYTES = 16 * 1024;
var MAX_KEY_JSON_BYTES = MAX_MUTATION_BYTES;
var MAX_ENCODED_KEY_CHARS = Math.ceil(MAX_KEY_JSON_BYTES / 3) * 4;
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var CURATION_REQUEST_ID_RE = /^lc_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
var SHA256_HEX_RE = /^[0-9a-f]{64}$/;
var PROJECT_ID_RE = /^p1_[0-9a-f]{64}$/;
var CURATION_ERROR_CODES = [
  "CURATION_CONFLICT",
  "CAPTURE_EXISTS",
  "SOURCE_CONFLICT",
  "SCOPE_CONFLICT",
  "INSTALLATION_MISMATCH",
  "UNSUPPORTED_SCHEMA",
  "STORAGE_UNAVAILABLE",
  "STORAGE_BUSY",
  "SENSITIVE_CONTENT",
  "PURGED",
  "INVALID_INPUT"
];
var MESSAGES = {
  CURATION_CONFLICT: "curation revision conflict",
  CAPTURE_EXISTS: "capture already exists",
  SOURCE_CONFLICT: "lesson source conflict",
  SCOPE_CONFLICT: "lesson scope conflict",
  INSTALLATION_MISMATCH: "different SIL installation",
  UNSUPPORTED_SCHEMA: "unsupported curation schema version",
  STORAGE_UNAVAILABLE: "curation storage unavailable",
  STORAGE_BUSY: "curation storage busy",
  SENSITIVE_CONTENT: "possible secret in curation field",
  PURGED: "lesson curation was purged",
  INVALID_INPUT: "invalid curation input"
};

class CurationError extends Error {
  code;
  name = "CurationError";
  fields;
  constructor(code, fields = []) {
    super(fields.length > 0 ? `${MESSAGES[code]}: ${fields.join(", ")}` : MESSAGES[code]);
    this.code = code;
    this.fields = [...fields];
  }
}
function utf8Bytes(value) {
  let bytes = 0;
  for (let i = 0;i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit < 128)
      bytes += 1;
    else if (unit < 2048)
      bytes += 2;
    else if (unit >= 55296 && unit <= 56319 && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      bytes += 4;
      i++;
    } else
      bytes += 3;
  }
  return bytes;
}
function isLowSurrogate(unit) {
  return unit >= 56320 && unit <= 57343;
}
function isWellFormed(value) {
  for (let i = 0;i < value.length; i++) {
    const unit = value.charCodeAt(i);
    if (unit >= 55296 && unit <= 56319) {
      if (i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1)))
        i++;
      else
        return false;
    } else if (isLowSurrogate(unit))
      return false;
  }
  return true;
}
function hasVisibleText(value) {
  return value.trim().length > 0;
}
function lessonKeyProblems(key) {
  const problems = [];
  if (typeof key.world !== "string" || !WORLD_NAME_RE.test(key.world)) {
    problems.push("world");
  }
  if (key.kind === "capture") {
    if (typeof key.id !== "string" || !UUID_RE.test(key.id))
      problems.push("id");
  } else if (key.kind === "inbox") {
    if (typeof key.id !== "string")
      problems.push("id");
  } else {
    problems.push("kind");
  }
  return problems;
}
var B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
function utf8Encode(value) {
  const out = [];
  for (let i = 0;i < value.length; i++) {
    let cp = value.charCodeAt(i);
    if (cp >= 55296 && cp <= 56319 && i + 1 < value.length && isLowSurrogate(value.charCodeAt(i + 1))) {
      cp = 65536 + (cp - 55296 << 10) + (value.charCodeAt(i + 1) - 56320);
      i++;
    } else if (cp >= 55296 && cp <= 57343) {
      cp = 65533;
    }
    if (cp < 128)
      out.push(cp);
    else if (cp < 2048)
      out.push(192 | cp >> 6, 128 | cp & 63);
    else if (cp < 65536)
      out.push(224 | cp >> 12, 128 | cp >> 6 & 63, 128 | cp & 63);
    else
      out.push(240 | cp >> 18, 128 | cp >> 12 & 63, 128 | cp >> 6 & 63, 128 | cp & 63);
  }
  return out;
}
function utf8Decode(bytes) {
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i];
    let cp;
    let need;
    let min;
    if (b0 < 128) {
      out += String.fromCharCode(b0);
      i++;
      continue;
    } else if (b0 >= 194 && b0 <= 223)
      [cp, need, min] = [b0 & 31, 1, 128];
    else if (b0 >= 224 && b0 <= 239)
      [cp, need, min] = [b0 & 15, 2, 2048];
    else if (b0 >= 240 && b0 <= 244)
      [cp, need, min] = [b0 & 7, 3, 65536];
    else
      return null;
    for (let k = 1;k <= need; k++) {
      const b = bytes[i + k];
      if (b === undefined || (b & 192) !== 128)
        return null;
      cp = cp << 6 | b & 63;
    }
    if (cp < min || cp > 1114111 || cp >= 55296 && cp <= 57343)
      return null;
    out += String.fromCodePoint(cp);
    i += need + 1;
  }
  return out;
}
function base64UrlEncode(bytes) {
  let out = "";
  for (let i = 0;i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL[b0 >> 2];
    out += B64URL[(b0 & 3) << 4 | (b1 ?? 0) >> 4];
    if (b1 !== undefined)
      out += B64URL[(b1 & 15) << 2 | (b2 ?? 0) >> 6];
    if (b2 !== undefined)
      out += B64URL[b2 & 63];
  }
  return out;
}
function base64UrlDecode(value) {
  if (value.length % 4 === 1)
    return null;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  for (const char of value) {
    const n = B64URL.indexOf(char);
    if (n < 0)
      return null;
    buffer = buffer << 6 | n;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push(buffer >> bits & 255);
    }
  }
  return bytes;
}
function encodeLessonKey(key) {
  if (lessonKeyProblems(key).length > 0)
    throw new CurationError("INVALID_INPUT", ["key"]);
  const bytes = utf8Encode(JSON.stringify([key.world, key.kind, key.id]));
  if (bytes.length > MAX_KEY_JSON_BYTES)
    throw new CurationError("INVALID_INPUT", ["key"]);
  return base64UrlEncode(bytes);
}
function decodeLessonKey(value) {
  const invalid = () => new CurationError("INVALID_INPUT", ["key"]);
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_ENCODED_KEY_CHARS)
    throw invalid();
  const bytes = base64UrlDecode(value);
  if (bytes === null || bytes.length > MAX_KEY_JSON_BYTES)
    throw invalid();
  const text = utf8Decode(bytes);
  if (text === null)
    throw invalid();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(parsed) || parsed.length !== 3 || !parsed.every((part) => typeof part === "string"))
    throw invalid();
  const [world, kind, id] = parsed;
  if (kind !== "capture" && kind !== "inbox")
    throw invalid();
  const key = { world, kind, id };
  if (lessonKeyProblems(key).length > 0)
    throw invalid();
  if (encodeLessonKey(key) !== value)
    throw invalid();
  return key;
}

// packages/core/src/curation-client.ts
var flatBinding = (binding) => `${binding.kind}:${binding.id}`;
var flatProject = (project) => project.kind === "project" ? project.id : project.kind;
function parseFlatProject(value) {
  if (value === "world" || value === "unresolved")
    return { kind: value };
  if (typeof value === "string" && PROJECT_ID_RE.test(value))
    return { kind: "project", id: value };
  return null;
}
function browseQuery(input) {
  const out = {
    world: input.world,
    project: flatProject(input.project),
    binding: flatBinding(input.binding),
    collection: input.collection
  };
  if (input.important !== undefined)
    out["important"] = input.important ? "true" : "false";
  if (input.search !== undefined && input.search !== "")
    out["search"] = input.search;
  if (input.cursor !== undefined)
    out["cursor"] = input.cursor;
  if (input.limit !== undefined)
    out["limit"] = String(input.limit);
  return out;
}

class CurationReadError extends Error {
  code;
  status;
  name = "CurationReadError";
  constructor(code, status) {
    super(`curation read failed: ${code}`);
    this.code = code;
    this.status = status;
  }
}
var malformed = () => {
  throw new CurationReadError("MALFORMED", null);
};
function rec(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return malformed();
  return value;
}
function exact(value, keys) {
  const r = rec(value);
  const own = Object.keys(r);
  if (own.length !== keys.length || !keys.every((k) => Object.hasOwn(r, k)))
    malformed();
  return r;
}
var str3 = (v) => typeof v === "string" ? v : malformed();
var strOrNull = (v) => v === null ? null : str3(v);
var bool = (v) => typeof v === "boolean" ? v : malformed();
var nat = (v) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : malformed();
var digestOrNull = (v) => v === null ? null : SHA256_HEX_RE.test(str3(v)) ? v : malformed();
function list(v, item) {
  if (!Array.isArray(v))
    return malformed();
  return v.map(item);
}
function decodeKey(value) {
  const r = exact(value, ["world", "kind", "id"]);
  const key = { world: str3(r["world"]), kind: str3(r["kind"]), id: str3(r["id"]) };
  if (lessonKeyProblems(key).length > 0)
    malformed();
  return key;
}
function decodeScope(value) {
  const r = exact(value, ["world", "project"]);
  const p = rec(r["project"]);
  let project;
  if (p["kind"] === "project") {
    exact(p, ["kind", "id"]);
    const id = str3(p["id"]);
    if (!PROJECT_ID_RE.test(id))
      malformed();
    project = { kind: "project", id };
  } else if (p["kind"] === "world" || p["kind"] === "unresolved") {
    exact(p, ["kind"]);
    project = { kind: p["kind"] };
  } else
    return malformed();
  return { world: str3(r["world"]), project };
}
var SOURCE_KEYS = ["kind", "quote", "reference", "quoteRedacted", "captureSessionId", "sourceConversationId", "sourceRowId", "sourceAgentId"];
function decodeSource(value) {
  const r = exact(value, SOURCE_KEYS);
  if (r["kind"] !== "explicit_quote" && r["kind"] !== "native_selection")
    malformed();
  return {
    kind: r["kind"],
    quote: strOrNull(r["quote"]),
    reference: strOrNull(r["reference"]),
    quoteRedacted: bool(r["quoteRedacted"]),
    captureSessionId: strOrNull(r["captureSessionId"]),
    sourceConversationId: strOrNull(r["sourceConversationId"]),
    sourceRowId: strOrNull(r["sourceRowId"]),
    sourceAgentId: strOrNull(r["sourceAgentId"])
  };
}
var STATUSES = ["saved", "queued", "archived", "missing", "changed", "conflict", "invalid", "purged"];
var VIEW_KEYS = ["key", "scope", "revision", "important", "effectiveText", "originalText", "source", "sourceStatus", "sourceDigest", "baselineDigest", "relatedPattern", "created", "updated"];
function decodeView(value) {
  const r = exact(value, VIEW_KEYS);
  const key = decodeKey(r["key"]);
  const scope = decodeScope(r["scope"]);
  if (scope.world !== key.world)
    malformed();
  const status = str3(r["sourceStatus"]);
  if (!STATUSES.includes(status))
    malformed();
  return {
    key,
    scope,
    revision: nat(r["revision"]),
    important: bool(r["important"]),
    effectiveText: strOrNull(r["effectiveText"]),
    originalText: strOrNull(r["originalText"]),
    source: r["source"] === null ? null : decodeSource(r["source"]),
    sourceStatus: status,
    sourceDigest: digestOrNull(r["sourceDigest"]),
    baselineDigest: digestOrNull(r["baselineDigest"]),
    relatedPattern: strOrNull(r["relatedPattern"]),
    created: str3(r["created"]),
    updated: str3(r["updated"])
  };
}
function decodeProvenance(value) {
  const r = rec(value);
  if (r["kind"] === "purged")
    return exact(r, ["kind"]) && { kind: "purged" };
  if (r["kind"] === "capture") {
    exact(r, ["kind", "source"]);
    return { kind: "capture", source: decodeSource(r["source"]) };
  }
  if (r["kind"] !== "existing_lesson")
    return malformed();
  if (r["state"] === "available") {
    exact(r, ["kind", "state", "location", "digest", "reflectionId", "repo", "pattern", "created"]);
    const location = str3(r["location"]);
    if (!["active", "archive", "both"].includes(location))
      malformed();
    return {
      kind: "existing_lesson",
      state: "available",
      location,
      digest: str3(r["digest"]),
      reflectionId: strOrNull(r["reflectionId"]),
      repo: strOrNull(r["repo"]),
      pattern: str3(r["pattern"]),
      created: str3(r["created"])
    };
  }
  if (r["state"] === "conflict") {
    exact(r, ["kind", "state", "copies"]);
    return {
      kind: "existing_lesson",
      state: "conflict",
      copies: list(r["copies"], (c) => {
        const x = exact(c, ["location", "digest", "reflectionId", "repo", "pattern", "created", "text"]);
        const location = str3(x["location"]);
        if (location !== "active" && location !== "archive")
          malformed();
        return {
          location,
          digest: str3(x["digest"]),
          reflectionId: strOrNull(x["reflectionId"]),
          repo: strOrNull(x["repo"]),
          pattern: str3(x["pattern"]),
          created: str3(x["created"]),
          text: str3(x["text"])
        };
      })
    };
  }
  if (r["state"] === "unavailable") {
    exact(r, ["kind", "state", "problem", "retainedDigest"]);
    return { kind: "existing_lesson", state: "unavailable", problem: str3(r["problem"]), retainedDigest: strOrNull(r["retainedDigest"]) };
  }
  return malformed();
}
function decodeLessonDetail(value) {
  const r = exact(value, ["lesson", "provenance", "diagnostics"]);
  const diagnostics = list(r["diagnostics"], (d) => {
    const x = rec(d);
    str3(x["code"]);
    return x;
  });
  return { lesson: decodeView(r["lesson"]), provenance: decodeProvenance(r["provenance"]), diagnostics };
}
function decodeStoreStatus(value) {
  const r = rec(value);
  if (r["state"] === "ready") {
    const b = exact(rec(r["binding"]), ["kind", "id"]);
    if (b["kind"] !== "installation" || !UUID_RE.test(str3(b["id"])))
      malformed();
    return { state: "ready", installationId: b["id"] };
  }
  if (r["state"] === "uninitialized") {
    const b = exact(rec(r["binding"]), ["kind", "id"]);
    if (b["kind"] !== "location" || !SHA256_HEX_RE.test(str3(b["id"])))
      malformed();
    return { state: "uninitialized", locationId: b["id"] };
  }
  if (r["state"] === "error")
    return { state: "error", code: str3(r["code"]) };
  return malformed();
}
function decodeReadResult(value, decodeValue) {
  const r = exact(value, ["store", "value"]);
  const s = exact(r["store"], ["locationId", "installationId"]);
  const locationId = str3(s["locationId"]);
  const installationId = strOrNull(s["installationId"]);
  if (!SHA256_HEX_RE.test(locationId) || installationId !== null && !UUID_RE.test(installationId))
    malformed();
  return { store: { locationId, installationId }, value: decodeValue(r["value"]) };
}
function decodeLocatedResult(value, installationId, key) {
  const result = decodeReadResult(value, (v) => v === null ? null : decodeScope(v));
  if (result.store.installationId !== installationId)
    throw new CurationReadError("INSTALLATION_MISMATCH", null);
  if (result.value !== null && result.value.world !== key.world)
    malformed();
  return result;
}
function decodeBrowsePage(value) {
  const r = exact(value, ["items", "nextCursor", "total", "sourceProblems", "sourceProblemsTotal"]);
  return {
    items: list(r["items"], decodeView),
    nextCursor: strOrNull(r["nextCursor"]),
    total: nat(r["total"]),
    sourceProblems: list(r["sourceProblems"], (p) => {
      const x = exact(p, ["location", "file", "problem"]);
      return { location: str3(x["location"]), file: str3(x["file"]), problem: str3(x["problem"]) };
    }),
    sourceProblemsTotal: nat(r["sourceProblemsTotal"])
  };
}
var REVISION_KINDS = ["capture", "edit", "important", "acknowledge-source", "purge"];
function decodeHistory(value) {
  const r = exact(value, ["items", "nextCursor", "total"]);
  const items = list(r["items"], (x) => {
    const e = exact(x, ["revision", "kind", "at", "text", "important", "oldSourceDigest", "newSourceDigest"]);
    const kind = str3(e["kind"]);
    if (!REVISION_KINDS.includes(kind))
      malformed();
    return {
      revision: nat(e["revision"]),
      kind,
      at: str3(e["at"]),
      text: strOrNull(e["text"]),
      important: e["important"] === null ? null : bool(e["important"]),
      oldSourceDigest: digestOrNull(e["oldSourceDigest"]),
      newSourceDigest: digestOrNull(e["newSourceDigest"])
    };
  });
  return { items, nextCursor: strOrNull(r["nextCursor"]), total: nat(r["total"]) };
}
function decodeProjects(value) {
  return list(value, (x) => {
    const c = exact(x, ["scope", "label", "root", "available", "origins"]);
    return {
      scope: decodeScope(c["scope"]),
      label: str3(c["label"]),
      root: strOrNull(c["root"]),
      available: bool(c["available"]),
      origins: list(c["origins"], (o) => str3(o))
    };
  });
}
function decodeReceiptRead(value, requestId) {
  const r = rec(value);
  if (r["requestId"] !== requestId)
    malformed();
  if (r["state"] === "unknown")
    return { state: "unknown", requestId };
  if (r["state"] === "purged") {
    exact(r, ["state", "requestId", "key", "startedAt", "finishedAt"]);
    return { state: "purged", requestId, key: decodeKey(r["key"]), startedAt: str3(r["startedAt"]), finishedAt: str3(r["finishedAt"]) };
  }
  if (r["state"] === "committed") {
    exact(r, ["state", "requestId", "payloadHash", "key", "revision", "changed", "startedAt", "finishedAt"]);
    return {
      state: "committed",
      requestId,
      payloadHash: str3(r["payloadHash"]),
      key: decodeKey(r["key"]),
      revision: nat(r["revision"]),
      changed: bool(r["changed"]),
      startedAt: str3(r["startedAt"]),
      finishedAt: str3(r["finishedAt"])
    };
  }
  return malformed();
}
function readbackConfirms(committedRevision, key, view) {
  return view.key.world === key.world && view.key.kind === key.kind && view.key.id === key.id && view.revision >= committedRevision;
}

// packages/core/src/curation-read.ts
var CURATION_MAX_RESULT_BYTES = 512 * 1024;
var CURATION_MAX_DIAGNOSTIC_BYTES = 64 * 1024;
var CURATION_MAX_SEARCH_CHARS = 200;

// packages/core/src/control-protocol.ts
var CONTROL_MAX_REQUEST_BYTES = 131072;
var CONTROL_MAX_RESPONSE_BYTES = 1048576;
var CONTROL_MAX_READS = 8;
var CONTROL_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

class ControlProtocolError extends Error {
  name = "ControlProtocolError";
}
var encoder = new TextEncoder;
function utf8ByteLength(text) {
  return encoder.encode(text).length;
}
function fail(message) {
  throw new ControlProtocolError(message);
}
function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys(value, required, where) {
  const keys = Object.keys(value);
  for (const key of keys) {
    if (!required.includes(key))
      fail(`${where}: unexpected key ${JSON.stringify(key).slice(0, 80)}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key))
      fail(`${where}: missing ${key}`);
  }
}
function parseJson(text, where) {
  try {
    return JSON.parse(text);
  } catch {
    return fail(`${where}: invalid JSON`);
  }
}
function parseControlRequest(value) {
  if (!isPlainObject(value))
    fail("request: must be a JSON object");
  exactKeys(value, ["version", "requestId", "reads"], "request");
  if (value["version"] !== 1)
    fail("request: unsupported version");
  const requestId = value["requestId"];
  if (typeof requestId !== "string" || !CONTROL_ID_RE.test(requestId))
    fail("request: invalid requestId");
  const reads = value["reads"];
  if (!Array.isArray(reads))
    fail("request: reads must be an array");
  if (reads.length < 1 || reads.length > CONTROL_MAX_READS)
    fail(`request: reads must hold 1 to ${CONTROL_MAX_READS} entries`);
  const seen = new Set;
  const out = [];
  reads.forEach((read, i) => {
    const where = `reads[${i}]`;
    if (!isPlainObject(read))
      fail(`${where}: must be an object`);
    exactKeys(read, ["id", "op", "args"], where);
    const { id, op, args } = read;
    if (typeof id !== "string" || !CONTROL_ID_RE.test(id))
      fail(`${where}: invalid id`);
    if (seen.has(id))
      fail(`${where}: duplicate id ${JSON.stringify(id)}`);
    seen.add(id);
    if (typeof op !== "string")
      fail(`${where}: op must be a string`);
    if (!isPlainObject(args))
      fail(`${where}: args must be an object`);
    out.push({ id, op, args });
  });
  return { version: 1, requestId, reads: out };
}
function decodeError(value, where) {
  if (!isPlainObject(value))
    fail(`${where}: error must be an object`);
  exactKeys(value, ["code", "message", "retryable"], where);
  const { code, message, retryable } = value;
  if (typeof code !== "string" || code.length === 0 || code.length > 64)
    fail(`${where}: invalid code`);
  if (typeof message !== "string")
    fail(`${where}: invalid message`);
  if (typeof retryable !== "boolean")
    fail(`${where}: invalid retryable`);
  return { code, message, retryable };
}
function decodeResult(value, where) {
  if (!isPlainObject(value))
    fail(`${where}: must be an object`);
  if (value["ok"] === true) {
    exactKeys(value, ["ok", "value"], where);
    return { ok: true, value: value["value"] };
  }
  if (value["ok"] === false) {
    exactKeys(value, ["ok", "error"], where);
    return { ok: false, error: decodeError(value["error"], `${where}.error`) };
  }
  return fail(`${where}: ok must be a boolean`);
}
function decodeControlResponse(text, requestId) {
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES)
    fail(`response: too large (over ${CONTROL_MAX_RESPONSE_BYTES} bytes)`);
  const value = parseJson(text, "response");
  if (!isPlainObject(value))
    fail("response: must be a JSON object");
  exactKeys(value, ["version", "requestId", "results"], "response");
  if (value["version"] !== 1)
    fail("response: unsupported version");
  if (value["requestId"] !== requestId)
    fail("response: requestId does not match the request");
  const raw = value["results"];
  if (!isPlainObject(raw))
    fail("response: results must be an object");
  const ids = Object.keys(raw);
  if (ids.length > CONTROL_MAX_READS)
    fail("response: too many results");
  const results = Object.create(null);
  for (const id of ids) {
    if (!CONTROL_ID_RE.test(id))
      fail("response: invalid result id");
    results[id] = decodeResult(raw[id], `results[${JSON.stringify(id)}]`);
  }
  return { version: 1, requestId, results };
}

// packages/core/src/control-mutation.ts
var MUTATION_MAX_REQUEST_BYTES = MAX_MUTATION_BYTES;
var CURATION_REFUSAL_CODES = new Set([
  "OpNotAllowed",
  "InvalidArgs",
  "UNSUPPORTED_OPERATION",
  "INVALID_INPUT",
  "SENSITIVE_CONTENT",
  "INSTALLATION_MISMATCH",
  "UNSUPPORTED_SCHEMA",
  "CURATION_CONFLICT",
  "CAPTURE_EXISTS",
  "SCOPE_CONFLICT",
  "SOURCE_CONFLICT",
  "PURGED",
  "STORAGE_BUSY"
]);
var CONFLICT_CODES = new Set(["CURATION_CONFLICT", "CAPTURE_EXISTS"]);
var OUTCOME_UNKNOWN_ERROR = Object.freeze({
  code: "OUTCOME_UNKNOWN",
  message: "mutation outcome unknown: look up its receipt by request id",
  retryable: false
});
function fail2(message) {
  throw new ControlProtocolError(message);
}
function isPlainObject2(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys2(value, required, optional, where) {
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key))
      fail2(`${where}: unexpected key`);
  }
  for (const key of required)
    if (!Object.hasOwn(value, key))
      fail2(`${where}: missing ${key}`);
}
function sameKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function parseJson2(text, where) {
  try {
    return JSON.parse(text);
  } catch {
    return fail2(`${where}: invalid JSON`);
  }
}
function parseMutationRequestEnvelope(value) {
  if (!isPlainObject2(value))
    fail2("request: must be a JSON object");
  exactKeys2(value, ["version", "requestId", "mutation"], [], "request");
  if (value["version"] !== 1)
    fail2("request: unsupported version");
  const requestId = value["requestId"];
  if (typeof requestId !== "string" || !CONTROL_ID_RE.test(requestId))
    fail2("request: invalid requestId");
  const m = value["mutation"];
  if (!isPlainObject2(m))
    fail2("mutation: must be an object");
  exactKeys2(m, ["op", "args", "confirmed"], ["expectedState"], "mutation");
  const { op, args, confirmed } = m;
  if (typeof op !== "string")
    fail2("mutation: op must be a string");
  if (!isPlainObject2(args))
    fail2("mutation: args must be an object");
  if (typeof confirmed !== "boolean")
    fail2("mutation: confirmed must be a boolean");
  const mutation = { op, args, confirmed };
  if (Object.hasOwn(m, "expectedState")) {
    const expectedState = m["expectedState"];
    if (typeof expectedState !== "string")
      fail2("mutation: expectedState must be a string");
    mutation.expectedState = expectedState;
  }
  return { version: 1, requestId, mutation };
}
function encodeMutationRequestEnvelope(envelope) {
  const text = JSON.stringify(parseMutationRequestEnvelope(envelope));
  if (utf8ByteLength(text) > MUTATION_MAX_REQUEST_BYTES)
    fail2(`request: too large (over ${MUTATION_MAX_REQUEST_BYTES} bytes)`);
  return text;
}
function classifyMutationFailure(error) {
  return typeof error.code === "string" && CURATION_REFUSAL_CODES.has(error.code) ? "refused" : "unknown";
}
function isTimestamp(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}
function isRevision(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function decodeKey2(value, where) {
  if (!isPlainObject2(value))
    fail2(`${where}: must be an object`);
  exactKeys2(value, ["world", "kind", "id"], [], where);
  const key = { world: value["world"], kind: value["kind"], id: value["id"] };
  if (lessonKeyProblems(key).length > 0)
    fail2(`${where}: invalid key`);
  return key;
}
function decodeReceipt(value, requestId) {
  const where = "receipt";
  if (!isPlainObject2(value))
    fail2(`${where}: must be an object`);
  exactKeys2(value, ["requestId", "payloadHash", "state", "result", "error", "startedAt", "finishedAt"], [], where);
  if (value["requestId"] !== requestId)
    fail2(`${where}: requestId does not match`);
  const { startedAt, finishedAt } = value;
  if (!isTimestamp(startedAt) || !isTimestamp(finishedAt))
    fail2(`${where}: invalid timestamps`);
  if (value["error"] !== null)
    fail2(`${where}: error must be null`);
  if (value["state"] === "purged") {
    if (value["payloadHash"] !== null || value["result"] !== null)
      fail2(`${where}: a purged receipt carries no data`);
    return { requestId, state: "purged", payloadHash: null, result: null, error: null, startedAt, finishedAt };
  }
  if (value["state"] !== "completed")
    fail2(`${where}: unsupported curation state`);
  const payloadHash = value["payloadHash"];
  if (typeof payloadHash !== "string" || !SHA256_HEX_RE.test(payloadHash))
    fail2(`${where}: invalid payloadHash`);
  const result = value["result"];
  if (!isPlainObject2(result))
    fail2(`${where}: result must be an object`);
  exactKeys2(result, ["key", "revision", "changed"], [], `${where}.result`);
  const key = decodeKey2(result["key"], `${where}.result.key`);
  const revision = result["revision"];
  const changed = result["changed"];
  if (!isRevision(revision))
    fail2(`${where}: invalid revision`);
  if (typeof changed !== "boolean")
    fail2(`${where}: invalid changed`);
  return { requestId, payloadHash, state: "completed", result: { key, revision, changed }, error: null, startedAt, finishedAt };
}
function decodeError2(value) {
  if (!isPlainObject2(value))
    fail2("error: must be an object");
  exactKeys2(value, ["code", "message", "retryable"], [], "error");
  const { code, message, retryable } = value;
  if (typeof code !== "string" || code.length === 0 || code.length > 64)
    fail2("error: invalid code");
  if (typeof message !== "string")
    fail2("error: invalid message");
  if (typeof retryable !== "boolean")
    fail2("error: invalid retryable");
  return { code, message, retryable };
}
function decodeCurationMutationResponse(text, requestId) {
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES)
    fail2(`response: too large (over ${CONTROL_MAX_RESPONSE_BYTES} bytes)`);
  if (!CONTROL_ID_RE.test(requestId))
    fail2("response: invalid request id");
  const value = parseJson2(text, "response");
  if (!isPlainObject2(value))
    fail2("response: must be a JSON object");
  const isSuccess = sameKeys(value, ["version", "requestId", "receipt", "store"]);
  const isFailure = sameKeys(value, ["version", "requestId", "error", "conflict"]);
  if (!isSuccess && !isFailure)
    fail2("response: not a success or failure envelope");
  if (value["version"] !== 1)
    fail2("response: unsupported version");
  if (value["requestId"] !== requestId)
    fail2("response: requestId does not match the request");
  if (isSuccess) {
    if (!CURATION_REQUEST_ID_RE.test(requestId))
      fail2("response: success for a non-curation request");
    const receipt = decodeReceipt(value["receipt"], requestId);
    const raw = value["store"];
    if (!isPlainObject2(raw))
      fail2("store: must be an object");
    exactKeys2(raw, ["locationId", "installationId"], [], "store");
    const { locationId, installationId } = raw;
    if (typeof locationId !== "string" || !SHA256_HEX_RE.test(locationId))
      fail2("store: invalid locationId");
    if (typeof installationId !== "string" || !UUID_RE.test(installationId))
      fail2("store: invalid installationId");
    return { version: 1, requestId, receipt, store: { locationId, installationId } };
  }
  const error = decodeError2(value["error"]);
  const conflictRaw = value["conflict"];
  let conflict = null;
  if (conflictRaw !== null) {
    if (!CONFLICT_CODES.has(error.code))
      fail2("response: conflict only with a revision conflict");
    if (!isPlainObject2(conflictRaw))
      fail2("conflict: must be an object");
    exactKeys2(conflictRaw, ["revision"], [], "conflict");
    if (!isRevision(conflictRaw["revision"]))
      fail2("conflict: invalid revision");
    conflict = { revision: conflictRaw["revision"] };
  }
  return { version: 1, requestId, error, conflict };
}

// packages/core/src/lesson-curation-ui.ts
var NO_AUTHORITY = { observation: null };
var MAX_DRAFT_BYTES = 64 * 1024;
var MAX_UNRESOLVED = 64;
var MAX_TOMBSTONES = 256;
var MAX_RESOLUTIONS = 64;
var CONFLICT_CODES2 = new Set([
  "CURATION_CONFLICT",
  "CAPTURE_EXISTS",
  "SOURCE_CONFLICT",
  "SCOPE_CONFLICT"
]);
var PHASES = ["idle", "editing", "saving", "saved", "conflict", "unknown", "purged", "error"];
var SOURCE_STATUSES = ["saved", "queued", "archived", "missing", "changed", "conflict", "invalid", "purged"];
var REVISION_KINDS2 = ["capture", "edit", "important", "acknowledge-source", "purge"];
var SOURCE_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
var SOURCE_FIELDS = [
  "kind",
  "quote",
  "reference",
  "quoteRedacted",
  "captureSessionId",
  "sourceConversationId",
  "sourceRowId",
  "sourceAgentId"
];
function initialLessonEditor() {
  return {
    generation: 0,
    gate: "unverified",
    needsFreshDetail: false,
    expectedInstallation: null,
    address: null,
    target: null,
    mode: null,
    loaded: null,
    history: null,
    base: null,
    draft: null,
    pending: null,
    unresolved: [],
    tombstones: [],
    tombstonesSaturated: false,
    resolutions: [],
    blocked: null,
    phase: "idle",
    error: null
  };
}
function isLessonEditorDirty(state) {
  const { draft, base } = state;
  if (draft === null || base === null)
    return false;
  return draft.text !== base.text || !sameSourceOrNull(draft.source, base.source);
}
function isLessonEditorStale(state) {
  return state.loaded !== null && state.base !== null && state.loaded.revision > state.base.revision;
}
function reduceLessonEditor(state, event, authority = NO_AUTHORITY) {
  if (!isRecord7(event))
    return state;
  if (event.type === "hydrate" || event.type === "restore") {
    if (state.target !== null || state.pending !== null || state.unresolved.length > 0 || state.tombstones.length > 0 || state.tombstonesSaturated) {
      return { ...state, error: invalid("activeImport") };
    }
    return event.type === "hydrate" ? hydrate(state, event.snapshot) : restore(state, event.state);
  }
  if (event.type === "disconnect")
    return {
      ...state,
      gate: state.gate === "mismatch" ? "mismatch" : "unverified",
      needsFreshDetail: state.target !== null,
      generation: state.generation + 1,
      loaded: null,
      history: null
    };
  if (event.type === "verify-store")
    return observeStore(state, authority.observation);
  if (event.type === "store-resolved") {
    if (!validResolution(event.resolution))
      return { ...state, error: invalid("resolution") };
    const observed = authority.observation;
    if (!observed || !sameBinding(observed.binding, event.resolution.location) || observed.installationId !== event.resolution.installation.id)
      return state;
    return observeStore(state, observed);
  }
  if (event.type === "attempt-outcome")
    return attemptOutcome(state, event, authority.attempt);
  if (state.gate === "mismatch" && !["receipt", "rejected"].includes(event.type))
    return state;
  if (["loaded", "detail-missing", "history-loaded", "read-failed", "receipt", "rejected"].includes(event.type)) {
    if (!matchesHostResult(event, authority))
      return state;
    if (event.type === "receipt" || event.type === "rejected") {
      const entry = state.pending?.requestId === event.requestId ? state.pending : state.unresolved.find((item) => item.requestId === event.requestId);
      if (!entry || !sameTarget(entry, event.target) || entry === state.pending && state.pending.generation !== event.generation)
        return state;
      const origin = installationOf(entry) ?? (entry === state.pending ? state.expectedInstallation : null);
      if (origin !== null && origin !== authority.result.installationId || event.type === "rejected" && event.code === "INSTALLATION_MISMATCH") {
        return state.pending === entry ? quarantine(state) : state;
      }
      if (event.type === "rejected" && installationOf(entry) === null)
        return state;
      state = attributeOperation(state, event, authority.result);
    } else {
      if (!("target" in event) || !("generation" in event) || !isCurrentRead(state, event.generation, event.target))
        return state;
      if (!authorityMatches(state, authority.observation) || state.gate === "unverified")
        return state;
      if (authority.result.installationId !== state.expectedInstallation)
        return quarantine(state);
    }
  }
  if (["submit", "rebase", "edit-text", "edit-source"].includes(event.type) && (state.gate !== "ready" || !authorityMatches(state, authority.observation))) {
    return { ...state, error: storeUnresolved() };
  }
  switch (event.type) {
    case "open-capture":
    case "open-lesson":
    case "close":
      return observeStore(requestNavigation(state, event), authority.observation);
    case "stay":
      return state.blocked === null ? state : { ...state, blocked: null };
    case "discard":
      return observeStore(discard(state), authority.observation);
    case "rebase":
      return rebase(state);
    case "edit-text":
      return editText(state, event.text);
    case "edit-source":
      return editSource(state, event.source);
    case "submit":
      return submit(state, event.requestId, event.intent);
    case "loaded":
      return loaded(state, event);
    case "detail-missing":
      if (state.mode !== "capture")
        return { ...state, error: invalid("missingDetail") };
      return { ...state, gate: "ready", needsFreshDetail: false, loaded: null, history: null, error: null };
    case "history-loaded":
      if (!isCurrentRead(state, event.generation, event.target) || !Array.isArray(event.revisions))
        return state;
      return { ...state, history: event.revisions };
    case "read-failed":
      if (!isCurrentRead(state, event.generation, event.target) || !isCurationCode(event.code))
        return state;
      return { ...state, error: { code: event.code, fields: [] }, phase: state.pending === null ? "error" : state.phase };
    case "receipt":
      return receipt(state, event);
    case "rejected":
      return rejected(state, event);
    default:
      return state;
  }
}
function prepareLessonMutation(state, requestId, authority = NO_AUTHORITY) {
  if (state.phase === "purged" || state.target !== null && isTombstoned(state, state.target))
    throw new CurationError("PURGED");
  const pending = state.pending;
  if (pending === null || pending.requestId !== requestId)
    throw new CurationError("INVALID_INPUT", ["requestId"]);
  if (pending.mutation === null)
    throw new CurationError("INVALID_INPUT", ["pending"]);
  if (state.gate === "mismatch")
    throw new CurationError("INSTALLATION_MISMATCH");
  if (state.gate !== "ready" || !authorityMatches(state, authority.observation) || isStoreUnresolved(state, pending)) {
    throw new CurationError("INSTALLATION_MISMATCH", ["authority"]);
  }
  const mutation = copyMutation(pending.mutation);
  const origin = installationOf(pending);
  if (mutation.binding.kind === "installation") {
    return { mutation, precondition: { kind: "installation", id: mutation.binding.id } };
  }
  if (origin !== null) {
    if (!authority.observation?.pinnedLocationRetry)
      throw new CurationError("INSTALLATION_MISMATCH", ["pinnedLocationRetry"]);
    return { mutation, precondition: { kind: "installation", id: origin } };
  }
  if (state.expectedInstallation !== null || state.phase !== "saving" || authority.observation?.installationId !== null) {
    throw new CurationError("INSTALLATION_MISMATCH", ["origin"]);
  }
  return { mutation, precondition: { kind: "uninitialized", locationId: mutation.binding.id } };
}
function snapshotLessonEditor(state) {
  const keepTarget = state.target !== null && (state.mode === "existing" || state.pending !== null) && state.phase !== "purged";
  return {
    version: 4,
    expectedInstallation: keepTarget ? state.expectedInstallation : null,
    address: keepTarget && state.address ? { ...state.address } : null,
    target: keepTarget && state.target ? copyTarget(state.target) : null,
    mode: keepTarget ? state.mode : null,
    pendingRequestId: keepTarget && state.pending ? state.pending.requestId : null,
    pendingIdentity: keepTarget && state.pending ? copyIdentity(state.pending) : null,
    unresolved: state.unresolved.map(copyIdentity),
    tombstones: state.tombstones.map(copyTarget),
    tombstonesSaturated: state.tombstonesSaturated,
    resolutions: state.resolutions.map(copyResolution)
  };
}
function projectLessonEditor(state) {
  const copy = cloneEditor(state);
  if (state.gate !== "ready" || state.target !== null && isStoreUnresolved(state, state.target)) {
    copy.loaded = null;
    copy.history = null;
    copy.base = null;
    copy.draft = null;
    copy.blocked = null;
  }
  if (copy.pending)
    copy.pending.mutation = null;
  return copy;
}
function cloneEditor(state) {
  return JSON.parse(JSON.stringify(state));
}

class LessonEditorController {
  #state = initialLessonEditor();
  #epoch = null;
  #observation = null;
  #attempts = new Map;
  get state() {
    return projectLessonEditor(this.#state);
  }
  get dirty() {
    return isLessonEditorDirty(this.#state);
  }
  get sending() {
    const pending = this.#state.pending;
    if (pending === null)
      return false;
    for (const attempt of this.#attempts.values())
      if (attempt.requestId === pending.requestId)
        return true;
    return false;
  }
  connect(connectionEpoch) {
    for (const { epoch: _epoch, ...attempt } of this.#attempts.values())
      this.#reportOutcome(attempt, { kind: "unknown" });
    this.#attempts.clear();
    this.#epoch = connectionEpoch;
    this.#observation = null;
    this.#state = reduceLessonEditor(this.#state, { type: "disconnect" });
  }
  observe(observation) {
    if (this.#epoch === null || observation.connectionEpoch !== this.#epoch)
      return;
    if (!validBinding(observation.binding) || observation.installationId !== null && !UUID_RE.test(observation.installationId))
      return;
    this.#observation = { ...observation, binding: { ...observation.binding } };
    this.#state = reduceLessonEditor(this.#state, { type: "verify-store" }, { observation: this.#observation });
  }
  dispatch(event, result) {
    if (event.type === "hydrate" || event.type === "restore" || event.type === "disconnect")
      this.#observation = null;
    this.#state = reduceLessonEditor(this.#state, event, { observation: this.#observation, result });
  }
  prepare(requestId) {
    return prepareLessonMutation(this.#state, requestId, { observation: this.#observation });
  }
  beginAttempt(requestId) {
    const prepared = this.prepare(requestId);
    const pending = this.#state.pending;
    if (this.#epoch === null || pending === null)
      throw new CurationError("INSTALLATION_MISMATCH", ["authority"]);
    for (const attempt of this.#attempts.values()) {
      if (attempt.requestId === requestId)
        throw new CurationError("INVALID_INPUT", ["inFlight"]);
    }
    if (this.#attempts.size > MAX_UNRESOLVED)
      throw new CurationError("INVALID_INPUT", ["attempts"]);
    const token = Object.freeze(Object.create(null));
    const precondition = prepared.precondition.kind === "installation" ? { kind: "installation", id: prepared.precondition.id } : { kind: "uninitialized", locationId: prepared.precondition.locationId };
    this.#attempts.set(token, {
      epoch: this.#epoch,
      generation: pending.generation,
      requestId,
      target: copyTarget(pending),
      precondition,
      origin: installationOf(pending) ?? this.#state.expectedInstallation,
      afterUnknown: this.#state.phase === "unknown"
    });
    return { token, prepared };
  }
  finishAttempt(token, completion) {
    const entry = this.#attempts.get(token);
    if (entry === undefined || entry.epoch !== this.#epoch)
      return;
    this.#attempts.delete(token);
    const { epoch: _epoch, ...attempt } = entry;
    if (isRecord7(completion) && completion.kind === "success")
      this.#finishSuccess(attempt, completion);
    else
      this.#reportOutcome(attempt, isRecord7(completion) ? completion : { kind: "unknown" });
  }
  #reportOutcome(attempt, outcome) {
    const event = {
      type: "attempt-outcome",
      generation: attempt.generation,
      requestId: attempt.requestId,
      target: copyTarget(attempt.target),
      outcome
    };
    this.#state = reduceLessonEditor(this.#state, event, { observation: this.#observation, attempt });
  }
  #finishSuccess(attempt, success) {
    const receipt = receiptFromTransport(attempt, success.receipt);
    const store = success.store;
    const storeOk = isRecord7(store) && typeof store.installationId === "string" && UUID_RE.test(store.installationId) && typeof store.locationId === "string" && SHA256_HEX_RE.test(store.locationId);
    const agrees = storeOk && (attempt.precondition.kind === "installation" ? store.installationId === attempt.precondition.id : store.locationId === attempt.precondition.locationId);
    if (receipt === null || this.#epoch === null || !storeOk || !agrees && attempt.origin === null) {
      this.#reportOutcome(attempt, { kind: "unknown" });
      return;
    }
    const target = copyTarget(attempt.target);
    const event = { type: "receipt", generation: attempt.generation, requestId: attempt.requestId, target, receipt };
    const result = {
      operation: "mutation",
      connectionEpoch: this.#epoch,
      generation: attempt.generation,
      target,
      requestId: attempt.requestId,
      installationId: store.installationId
    };
    this.#state = reduceLessonEditor(this.#state, event, { observation: this.#observation, result });
    const pending = this.#state.pending;
    if (pending !== null && pending.requestId === attempt.requestId && pending.generation === attempt.generation && this.#state.phase === "saving") {
      this.#reportOutcome(attempt, { kind: "unknown" });
    }
  }
  snapshot() {
    return snapshotLessonEditor(this.#state);
  }
  exportForRestore() {
    return cloneEditor(this.#state);
  }
}
function requestNavigation(state, nav) {
  if (!validNavigation(nav))
    return { ...state, error: invalid("navigation") };
  if (isLessonEditorDirty(state))
    return { ...state, blocked: copyNavigation(nav) };
  return navigate(state, nav);
}
function navigate(state, nav) {
  if (nav.type !== "close" && state.tombstonesSaturated) {
    return { ...state, blocked: null, error: saturated("tombstones") };
  }
  if (state.pending !== null && state.unresolved.length >= MAX_UNRESOLVED) {
    return { ...state, blocked: null, error: saturated("unresolved") };
  }
  const generation = state.generation + 1;
  const unresolved = state.pending === null ? state.unresolved : [...state.unresolved, copyIdentity(state.pending)];
  const cleared = {
    ...initialLessonEditor(),
    generation,
    unresolved,
    tombstones: state.tombstones,
    tombstonesSaturated: state.tombstonesSaturated,
    resolutions: state.resolutions
  };
  if (nav.type === "close")
    return cleared;
  const isCapture = nav.type === "open-capture";
  const key = isCapture ? { world: nav.scope.world, kind: "capture", id: nav.recordId } : { ...nav.key };
  const target = { scope: copyScope(nav.scope), binding: { ...nav.binding }, key };
  const mode = isCapture ? "capture" : "existing";
  cleared.expectedInstallation = expectedFor(target, cleared.resolutions);
  cleared.address = { ...nav.binding };
  cleared.needsFreshDetail = !isCapture;
  if (isTombstoned(cleared, target))
    return { ...cleared, target, mode, phase: "purged" };
  if (isStoreUnresolved(cleared, target))
    return { ...cleared, target, mode, phase: "error", error: storeUnresolved() };
  if (!isCapture)
    return { ...cleared, target, mode };
  const source = { ...nav.source };
  return {
    ...cleared,
    target,
    mode,
    base: { revision: 0, text: "", important: false, source },
    draft: { text: "", source: { ...source } }
  };
}
function discard(state) {
  if (state.blocked !== null)
    return navigate(state, state.blocked);
  if (state.draft === null || state.base === null || state.phase === "purged")
    return state;
  return {
    ...state,
    draft: { text: state.base.text, source: state.base.source === null ? null : { ...state.base.source } },
    error: null,
    phase: state.pending === null ? "idle" : state.phase
  };
}
function rebase(state) {
  if (state.mode !== "existing" || state.pending !== null || state.draft === null || state.loaded === null)
    return state;
  if (!isLessonEditorStale(state))
    return state;
  const next = { ...state, base: baseFromView(state.loaded), error: null };
  return { ...next, phase: isLessonEditorDirty(next) ? "editing" : "idle" };
}
function editText(state, text) {
  if (state.draft === null || state.phase === "purged")
    return state;
  if (typeof text !== "string" || !isWellFormed(text) || utf8Bytes(text) > MAX_DRAFT_BYTES) {
    return { ...state, error: invalid("text") };
  }
  return settleEditPhase({ ...state, draft: { ...state.draft, text }, error: null });
}
function editSource(state, source) {
  if (state.mode !== "capture" || state.draft === null || state.pending !== null || state.phase === "purged")
    return state;
  if (!validSource(source))
    return { ...state, error: invalid("source") };
  return settleEditPhase({ ...state, draft: { ...state.draft, source: { ...source } }, error: null });
}
function settleEditPhase(next) {
  if (next.pending !== null)
    return next;
  return { ...next, phase: isLessonEditorDirty(next) ? "editing" : "idle" };
}
function submit(state, requestId, intent) {
  if (state.pending !== null || state.phase === "purged" || state.blocked !== null)
    return state;
  if (state.target === null)
    return { ...state, error: invalid("target") };
  if (isTombstoned(state, state.target))
    return { ...state, error: { code: "PURGED", fields: [] } };
  if (isStoreUnresolved(state, state.target))
    return { ...state, error: storeUnresolved() };
  if (typeof requestId !== "string" || !CURATION_REQUEST_ID_RE.test(requestId))
    return { ...state, error: invalid("requestId") };
  if (state.unresolved.some((item) => item.requestId === requestId))
    return { ...state, error: invalid("requestId") };
  const built = buildChange(state, intent);
  if ("problems" in built)
    return { ...state, error: { code: "INVALID_INPUT", fields: built.problems } };
  const target = state.expectedInstallation === null ? state.target : { scope: copyScope(state.target.scope), key: { ...state.target.key }, binding: { kind: "installation", id: state.expectedInstallation } };
  const mutation = {
    requestId,
    binding: { ...target.binding },
    scope: copyScope(target.scope),
    key: { ...target.key },
    expectedRevision: built.expectedRevision,
    change: built.change
  };
  if (utf8Bytes(JSON.stringify(mutation)) > MAX_MUTATION_BYTES)
    return { ...state, error: invalid("$") };
  const pending = { ...copyIdentity({ requestId, ...target }), generation: state.generation, mutation };
  return { ...state, target, pending, phase: "saving", error: null };
}
function buildChange(state, intent) {
  if (!isRecord7(intent))
    return { problems: ["intent"] };
  const { base, draft, mode } = state;
  if (intent.kind === "save") {
    if (draft === null || base === null)
      return { problems: ["draft"] };
    const problems = textProblems(draft.text, "text", MAX_TEXT_BYTES);
    if (mode === "capture") {
      const source = draft.source;
      if (source === null)
        return { problems: ["source"] };
      problems.push(...textProblems(source.quote, "source.quote", MAX_QUOTE_BYTES));
      problems.push(...textProblems(source.reference, "source.reference", MAX_REFERENCE_BYTES));
      if (source.quote === null && source.reference === null)
        problems.push("source");
      if (problems.length > 0)
        return { problems };
      return { change: { kind: "capture", text: draft.text, source: { ...source } }, expectedRevision: 0 };
    }
    if (problems.length > 0)
      return { problems };
    return { change: { kind: "edit", text: draft.text }, expectedRevision: base.revision };
  }
  if (mode !== "existing" || base === null)
    return { problems: ["intent"] };
  if (intent.kind === "important") {
    if (typeof intent.value !== "boolean")
      return { problems: ["intent.value"] };
    return { change: { kind: "important", value: intent.value }, expectedRevision: base.revision };
  }
  if (intent.kind === "acknowledge-source") {
    if (typeof intent.digest !== "string" || !SHA256_HEX_RE.test(intent.digest))
      return { problems: ["intent.digest"] };
    return { change: { kind: "acknowledge-source", digest: intent.digest }, expectedRevision: base.revision };
  }
  if (intent.kind === "purge") {
    if (intent.confirmed !== true)
      return { problems: ["intent.confirmed"] };
    return { change: { kind: "purge", confirmed: true }, expectedRevision: base.revision };
  }
  return { problems: ["intent"] };
}
function textProblems(value, field, maxBytes) {
  if (value === null)
    return [];
  return isWellFormed(value) && hasVisibleText(value) && utf8Bytes(value) <= maxBytes ? [] : [field];
}
function isCurrentRead(state, generation, target) {
  return generation === state.generation && state.target !== null && state.phase !== "purged" && (state.gate === "ready" || state.gate === "reading") && sameCanonicalTarget(state, target, state.target) && !isTombstoned(state, state.target) && !isStoreUnresolved(state, state.target);
}
function loaded(state, event) {
  if (!isCurrentRead(state, event.generation, event.target) || !state.target)
    return state;
  const view = event.view;
  if (!isRecord7(view) || !isRevision2(view.revision))
    return state;
  if (!sameKey(view.key, state.target.key))
    return mismatch(state, "INVALID_INPUT", "view.key");
  if (!sameScope(view.scope, state.target.scope))
    return mismatch(state, "SCOPE_CONFLICT", "view.scope");
  if (view.sourceStatus === "purged")
    return purge(state, state.target);
  const newestSeen = Math.max(state.loaded?.revision ?? -1, state.base?.revision ?? -1);
  if (view.revision < newestSeen)
    return state;
  if (state.base === null || state.pending === null && !isLessonEditorDirty(state)) {
    const base = baseFromView(view);
    return {
      ...state,
      mode: "existing",
      gate: "ready",
      needsFreshDetail: false,
      loaded: view,
      base,
      draft: { text: base.text, source: null },
      phase: state.phase === "error" && state.pending === null ? "idle" : state.phase,
      error: state.pending === null ? null : state.error
    };
  }
  return { ...state, gate: "ready", needsFreshDetail: false, loaded: view, error: null };
}
function mismatch(state, code, field) {
  return { ...state, error: { code, fields: [field] }, phase: state.pending === null ? "error" : state.phase };
}
function receipt(state, event) {
  const r = event.receipt;
  if (!isRecord7(r) || r.requestId !== event.requestId)
    return state;
  const pending = state.pending;
  const forPending = pending !== null && event.generation === pending.generation && pending.requestId === event.requestId && sameCanonicalTarget(state, event.target, pending);
  const forUnresolved = findUnresolved(state, event.requestId, event.target) >= 0;
  if (!forPending && !forUnresolved)
    return state;
  if (r.state !== "unknown" && !sameKey(isRecord7(event.target) ? event.target.key : null, r.key)) {
    return forPending ? mismatch(state, "INVALID_INPUT", "receipt.key") : { ...state, error: invalid("receipt.key") };
  }
  if (forUnresolved)
    return settleUnresolved(state, event.requestId, event.target, r) ?? state;
  if (pending === null)
    return state;
  if (r.state === "unknown")
    return { ...state, phase: "unknown", error: null };
  if (r.state === "purged")
    return purge(state, pending);
  if (r.state !== "committed" || !isRevision2(r.revision))
    return state;
  return applyCommit(state, pending, r.revision);
}
function applyCommit(state, pending, revision) {
  const change = pending.mutation?.change ?? null;
  if (change?.kind === "purge")
    return purge(state, pending);
  let base = state.base;
  let draft = state.draft;
  if (base !== null && change !== null && revision > base.revision) {
    base = { ...base, revision };
    if (change.kind === "capture" || change.kind === "edit")
      base.text = change.text;
    if (change.kind === "important")
      base.important = change.value;
  }
  if (state.mode === "capture") {
    if (base !== null)
      base = { ...base, source: null };
    if (draft !== null)
      draft = { ...draft, source: null };
  }
  const next = { ...state, mode: "existing", base, draft, pending: null, error: null };
  return { ...next, phase: isLessonEditorDirty(next) ? "editing" : "saved" };
}
function rejected(state, event) {
  if (!isCurationCode(event.code))
    return state;
  const settled = settleUnresolved(state, event.requestId, event.target, event.code === "PURGED" ? "purged" : "rejected");
  if (settled !== null)
    return settled;
  const pending = state.pending;
  if (pending === null || event.generation !== pending.generation || pending.requestId !== event.requestId)
    return state;
  if (!sameCanonicalTarget(state, event.target, pending))
    return state;
  if (event.code === "PURGED")
    return purge(state, pending);
  const fields = Array.isArray(event.fields) ? event.fields.filter((field) => typeof field === "string") : [];
  return {
    ...state,
    pending: null,
    phase: CONFLICT_CODES2.has(event.code) ? "conflict" : "error",
    error: { code: event.code, fields }
  };
}
function settleUnresolved(state, requestId, target, outcome) {
  const index = findUnresolved(state, requestId, target);
  if (index < 0)
    return null;
  if (outcome !== "purged" && outcome !== "rejected" && outcome.state === "unknown")
    return state;
  const entry = state.unresolved[index];
  const next = { ...state, unresolved: state.unresolved.filter((_, i) => i !== index) };
  const purged = outcome === "purged" || typeof outcome === "object" && outcome.state === "purged";
  if (!purged)
    return next;
  if (next.target !== null && next.phase !== "purged") {
    if (sameRecord(next, next.target, entry))
      return purge(next, entry);
    if (sameKey(next.target.key, entry.key) && recordRelation(next.target, entry) === "unknown") {
      return addTombstone(failClosed(next), entry);
    }
  }
  return addTombstone(next, entry);
}
function findUnresolved(state, requestId, target) {
  return state.unresolved.findIndex((item) => item.requestId === requestId && sameCanonicalTarget(state, target, item));
}
function failClosed(state) {
  return {
    ...state,
    gate: state.gate === "mismatch" ? "mismatch" : "unverified",
    needsFreshDetail: true,
    loaded: null,
    history: null,
    blocked: null,
    phase: "error",
    error: storeUnresolved()
  };
}
function installationOf(target) {
  return target.binding.kind === "installation" ? target.binding.id : target.installationId ?? null;
}
function expectedFor(target, hints) {
  if (!target)
    return null;
  return installationOf(target) ?? hints.find((hint) => sameBinding(hint.location, target.binding))?.installation.id ?? null;
}
function observationAddresses(target, observation) {
  return sameBinding(observation.binding, target.binding) || installationOf(target) !== null && installationOf(target) === observation.installationId;
}
function authorityMatches(state, observation) {
  return observation !== null && state.target !== null && (observationAddresses(state.target, observation) || state.address !== null && sameBinding(observation.binding, state.address)) && observation.installationId === state.expectedInstallation;
}
function quarantine(state) {
  return {
    ...state,
    gate: "mismatch",
    needsFreshDetail: true,
    generation: state.generation + (state.gate === "mismatch" ? 0 : 1),
    loaded: null,
    history: null,
    blocked: null,
    error: { code: "INSTALLATION_MISMATCH", fields: ["binding"] }
  };
}
function observeStore(state, observation) {
  if (!observation || !state.target || state.phase === "purged" || !(observationAddresses(state.target, observation) || state.address !== null && sameBinding(observation.binding, state.address)))
    return state;
  const expected = state.expectedInstallation ?? expectedFor(state.target, state.resolutions);
  if (expected !== null && observation.installationId !== expected)
    return quarantine({ ...state, expectedInstallation: expected });
  if (state.pending !== null && installationOf(state.pending) === null && observation.installationId !== null || expected === null && state.mode === "existing" && state.base !== null) {
    return { ...state, gate: "unverified", loaded: null, history: null, error: storeUnresolved() };
  }
  const target = observation.installationId === null || state.target.binding.kind === "installation" ? state.target : { ...state.target, installationId: observation.installationId };
  const recovering = state.gate === "unverified" || state.gate === "mismatch";
  const next = {
    ...state,
    target,
    expectedInstallation: expected ?? observation.installationId,
    generation: state.generation + (state.gate === "mismatch" ? 1 : 0),
    gate: recovering ? state.mode === "capture" && state.pending === null && !state.needsFreshDetail ? "ready" : "reading" : state.gate
  };
  if (isTombstoned(next, target))
    return purge(next, target);
  if (isStoreUnresolved(next, target))
    return { ...next, error: storeUnresolved() };
  return { ...next, error: recovering ? null : state.error };
}
function matchesHostResult(event, authority) {
  const result = authority.result;
  if (!result || !authority.observation || result.connectionEpoch !== authority.observation.connectionEpoch)
    return false;
  if (!("target" in event) || !("generation" in event) || result.generation !== event.generation || !sameTarget(result.target, event.target))
    return false;
  return "requestId" in event ? result.requestId === event.requestId && result.operation !== "read" : result.requestId === undefined && result.operation === "read";
}
function attributeOperation(state, event, result) {
  if (event.type !== "receipt" || result.installationId === null || event.receipt.requestId !== event.requestId || (event.receipt.state === "unknown" ? result.operation !== "mutation" : !sameKey(event.receipt.key, event.target.key)))
    return state;
  const attribute = (entry) => entry.requestId === event.requestId && sameTarget(entry, event.target) && installationOf(entry) === null ? { ...entry, installationId: result.installationId } : entry;
  const pending = state.pending === null ? null : attribute(state.pending);
  const unresolved = state.unresolved.map(attribute);
  if (pending === state.pending && unresolved.every((entry, index) => entry === state.unresolved[index]))
    return state;
  if (pending !== state.pending && pending !== null && state.expectedInstallation === null) {
    return {
      ...state,
      pending,
      unresolved,
      expectedInstallation: result.installationId,
      target: state.target === null ? null : { ...state.target, installationId: result.installationId }
    };
  }
  return { ...state, pending, unresolved };
}
function attemptOutcome(state, event, attempt) {
  if (!attempt || attempt.generation !== event.generation || attempt.requestId !== event.requestId || !sameTarget(attempt.target, event.target))
    return state;
  const pending = state.pending;
  if (pending === null || pending.requestId !== event.requestId || pending.generation !== event.generation || !sameTarget(pending, event.target))
    return state;
  const outcome = event.outcome;
  if (!isRecord7(outcome) || outcome.kind !== "refused" || typeof outcome.code !== "string" || !CURATION_REFUSAL_CODES.has(outcome.code)) {
    return markUnknown(state);
  }
  const code = outcome.code;
  const fields = Array.isArray(outcome.fields) ? outcome.fields.filter((field) => typeof field === "string" && field.length <= 128).slice(0, 32) : [];
  const error = refusalError(code, fields);
  const origin = attempt.origin;
  if (attempt.afterUnknown || state.phase === "unknown") {
    if (code === "INSTALLATION_MISMATCH" && origin !== null)
      return { ...quarantine(state), phase: "unknown" };
    return { ...state, phase: "unknown", error: state.gate === "mismatch" ? state.error : error };
  }
  if (code === "INSTALLATION_MISMATCH") {
    if (origin !== null)
      return { ...quarantine(state), pending: null, phase: "error" };
    return {
      ...state,
      gate: state.gate === "mismatch" ? "mismatch" : "unverified",
      needsFreshDetail: true,
      loaded: null,
      history: null,
      blocked: null,
      phase: "unknown",
      error: { code: "INSTALLATION_MISMATCH", fields: ["binding"] }
    };
  }
  if (code === "PURGED") {
    const pinned = origin !== null && attempt.precondition.kind === "installation" && attempt.precondition.id === origin;
    return pinned ? purge(state, pending) : markUnknown(state);
  }
  if (state.gate === "mismatch")
    return { ...state, pending: null, phase: "error" };
  return { ...state, pending: null, phase: CONFLICT_CODES2.has(code) ? "conflict" : "error", error };
}
function markUnknown(state) {
  const keep = state.gate === "mismatch" || state.error?.code === "STORE_UNRESOLVED" || state.error?.code === "INSTALLATION_MISMATCH";
  return { ...state, phase: "unknown", error: keep ? state.error : null };
}
function refusalError(code, fields) {
  return isCurationCode(code) ? { code, fields } : { code: "INVALID_INPUT", fields: ["request"] };
}
function receiptFromTransport(attempt, value) {
  if (!isRecord7(value) || value.requestId !== attempt.requestId)
    return null;
  const { startedAt, finishedAt } = value;
  if (typeof startedAt !== "string" || typeof finishedAt !== "string")
    return null;
  if (value.state === "purged")
    return { state: "purged", requestId: attempt.requestId, key: { ...attempt.target.key }, startedAt, finishedAt };
  const result = value.result;
  if (value.state !== "completed" || !isRecord7(result) || typeof value.payloadHash !== "string" || !isRevision2(result.revision) || typeof result.changed !== "boolean" || !isRecord7(result.key))
    return null;
  const key = result.key;
  return {
    state: "committed",
    requestId: attempt.requestId,
    payloadHash: value.payloadHash,
    key: { world: key.world, kind: key.kind, id: key.id },
    revision: result.revision,
    changed: result.changed,
    startedAt,
    finishedAt
  };
}
function purge(state, record) {
  return addTombstone({
    ...state,
    loaded: null,
    history: null,
    base: null,
    draft: null,
    pending: null,
    blocked: null,
    phase: "purged",
    error: null
  }, record);
}
function addTombstone(state, record) {
  if (isTombstoned(state, record))
    return state;
  if (state.tombstones.length >= MAX_TOMBSTONES) {
    return { ...state, tombstonesSaturated: true, error: saturated("tombstones") };
  }
  return { ...state, tombstones: [...state.tombstones, copyTarget(record)] };
}
var SNAPSHOT_KEYS = [
  "version",
  "target",
  "mode",
  "pendingRequestId",
  "unresolved",
  "tombstones",
  "tombstonesSaturated",
  "resolutions"
];
function hydrate(state, snapshot) {
  const rejectedState = { ...state, error: invalid("snapshot") };
  if (!isRecord7(snapshot) || !exactKeys3(snapshot, snapshot.version === 4 ? [...SNAPSHOT_KEYS, "expectedInstallation", "pendingIdentity", "address"] : SNAPSHOT_KEYS))
    return rejectedState;
  if (snapshot.version !== 3 && snapshot.version !== 4 || typeof snapshot.tombstonesSaturated !== "boolean")
    return rejectedState;
  const resolutions = parseResolutions(snapshot.resolutions);
  if (resolutions === null)
    return rejectedState;
  const target = snapshot.target;
  if (target !== null && !validTarget(target))
    return rejectedState;
  const expected = snapshot.version === 4 ? snapshot.expectedInstallation : expectedFor(target, resolutions);
  if (!validExpected(expected, target))
    return rejectedState;
  const address = snapshot.version === 4 ? snapshot.address : target?.binding ?? null;
  if (target === null ? address !== null : !validBinding(address))
    return rejectedState;
  if (!validModeFor(snapshot.mode, target))
    return rejectedState;
  const requestId = snapshot.pendingRequestId;
  if (requestId !== null && (target === null || !isRequestId(requestId)))
    return rejectedState;
  if (snapshot.version === 4 && requestId === null && snapshot.pendingIdentity !== null)
    return rejectedState;
  if (target !== null && snapshot.mode === "capture" && requestId === null)
    return rejectedState;
  const unresolved = parseUnresolved(snapshot.unresolved);
  const tombstones = parseTombstones(snapshot.tombstones);
  if (unresolved === null || tombstones === null)
    return rejectedState;
  if (requestId !== null && unresolved.some((item) => item.requestId === requestId))
    return rejectedState;
  const generation = state.generation + 1;
  const base = {
    ...initialLessonEditor(),
    generation,
    unresolved,
    tombstones,
    tombstonesSaturated: snapshot.tombstonesSaturated,
    needsFreshDetail: target !== null,
    expectedInstallation: expected,
    address: address === null ? null : { ...address },
    resolutions
  };
  if (target === null)
    return base;
  if (isTombstoned(base, target))
    return rejectedState;
  const copied = copyTarget(target);
  const identity = snapshot.version === 4 ? snapshot.pendingIdentity : requestId === null ? null : { requestId, ...copied };
  if (requestId === null ? identity !== null : !validIdentity(identity) || identity.requestId !== requestId || !sameTarget(identity, copied))
    return rejectedState;
  const pending = identity === null ? null : { ...copyIdentity(identity), generation, mutation: null };
  if (pending !== null && expected !== null && installationOf(pending) !== null && installationOf(pending) !== expected)
    return rejectedState;
  const restored = { ...base, target: copied, mode: snapshot.mode, pending };
  if (isStoreUnresolved(restored, copied))
    return { ...restored, phase: pending ? "unknown" : "error", error: storeUnresolved() };
  return { ...restored, phase: pending ? "unknown" : "idle" };
}
var STATE_KEYS = [
  "generation",
  "target",
  "mode",
  "loaded",
  "history",
  "base",
  "draft",
  "pending",
  "unresolved",
  "tombstones",
  "tombstonesSaturated",
  "resolutions",
  "blocked",
  "phase",
  "error"
];
function restore(state, input) {
  const rejectedState = { ...state, error: invalid("state") };
  if (!isRecord7(input) || !exactKeys3(input, Object.hasOwn(input, "gate") ? [...STATE_KEYS, "gate", "needsFreshDetail", "expectedInstallation", "address"] : STATE_KEYS))
    return rejectedState;
  const s = input;
  if (!isRevision2(s.generation) || !PHASES.includes(s.phase))
    return rejectedState;
  if (typeof s.tombstonesSaturated !== "boolean")
    return rejectedState;
  if (s.target !== null && !validTarget(s.target))
    return rejectedState;
  const target = s.target;
  if (!validModeFor(s.mode, target))
    return rejectedState;
  const unresolved = parseUnresolved(s.unresolved);
  const tombstones = parseTombstones(s.tombstones);
  const resolutions = parseResolutions(s.resolutions);
  if (unresolved === null || tombstones === null || resolutions === null)
    return rejectedState;
  const expected = Object.hasOwn(s, "expectedInstallation") ? s.expectedInstallation : expectedFor(target, resolutions);
  if (!validExpected(expected, target))
    return rejectedState;
  const address = Object.hasOwn(s, "address") ? s.address : target?.binding ?? null;
  if (target === null ? address !== null : !validBinding(address))
    return rejectedState;
  if (s.loaded !== null) {
    if (target === null || !validView(s.loaded))
      return rejectedState;
    if (!sameKey(s.loaded.key, target.key) || !sameScope(s.loaded.scope, target.scope))
      return rejectedState;
  }
  if (s.history !== null && !(target !== null && Array.isArray(s.history) && s.history.every(validRevisionEntry)))
    return rejectedState;
  if (s.base !== null && !validBase(s.base, s.mode))
    return rejectedState;
  if (s.draft !== null && !validDraft(s.draft, s.mode))
    return rejectedState;
  if (s.draft !== null && s.base === null)
    return rejectedState;
  if (s.blocked !== null && !validNavigation(s.blocked))
    return rejectedState;
  if (s.error !== null && !validError(s.error))
    return rejectedState;
  if (s.pending !== null && !(target !== null && validPending(s.pending, target)))
    return rejectedState;
  const oldPending = s.pending;
  if (oldPending !== null && expected !== null && installationOf(oldPending) !== null && installationOf(oldPending) !== expected)
    return rejectedState;
  if (oldPending !== null && unresolved.some((item) => item.requestId === oldPending.requestId))
    return rejectedState;
  const purgedPhase = s.phase === "purged";
  if (purgedPhase && (s.draft !== null || s.base !== null || s.loaded !== null || s.history !== null || s.pending !== null)) {
    return rejectedState;
  }
  const probe = { ...initialLessonEditor(), tombstones, unresolved, resolutions };
  if (purgedPhase) {
    if (target === null)
      return rejectedState;
    if (!isTombstoned(probe, target) && !tombstones.some((item) => sameTarget(item, target)) && !s.tombstonesSaturated)
      return rejectedState;
  } else if (target !== null) {
    if (isTombstoned(probe, target))
      return rejectedState;
  }
  const generation = Math.max(state.generation, s.generation) + 1;
  const pending = oldPending === null ? null : { ...copyIdentity(oldPending), generation, mutation: null };
  const error = s.error;
  return {
    generation,
    gate: "unverified",
    needsFreshDetail: target !== null,
    expectedInstallation: expected,
    address: address === null ? null : { ...address },
    target: target === null ? null : copyTarget(target),
    mode: s.mode,
    loaded: null,
    history: null,
    base: s.base === null ? null : copyBase(s.base),
    draft: s.draft === null ? null : copyDraft(s.draft),
    pending,
    unresolved,
    tombstones,
    tombstonesSaturated: s.tombstonesSaturated,
    resolutions,
    blocked: s.blocked === null ? null : copyNavigation(s.blocked),
    phase: pending !== null ? "unknown" : s.phase,
    error: target !== null && !purgedPhase && isStoreUnresolved(probe, target) ? storeUnresolved() : error === null ? null : { code: error.code, fields: [...error.fields] }
  };
}
function isRecord7(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exactKeys3(value, keys) {
  if (!isRecord7(value))
    return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function isRevision2(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isRequestId(value) {
  return typeof value === "string" && CURATION_REQUEST_ID_RE.test(value);
}
function isCurationCode(value) {
  return typeof value === "string" && CURATION_ERROR_CODES.includes(value);
}
function isDigestOrNull(value) {
  return value === null || typeof value === "string" && SHA256_HEX_RE.test(value);
}
function isStringOrNull(value) {
  return value === null || typeof value === "string";
}
function validScope(value) {
  if (!exactKeys3(value, ["world", "project"]))
    return false;
  if (typeof value.world !== "string" || !WORLD_NAME_RE.test(value.world))
    return false;
  const project = value.project;
  if (exactKeys3(project, ["kind", "id"]))
    return project.kind === "project" && typeof project.id === "string" && PROJECT_ID_RE.test(project.id);
  return exactKeys3(project, ["kind"]) && (project.kind === "world" || project.kind === "unresolved");
}
function validBinding(value) {
  if (!exactKeys3(value, ["kind", "id"]) || typeof value.id !== "string")
    return false;
  if (value.kind === "installation")
    return UUID_RE.test(value.id);
  if (value.kind === "location")
    return SHA256_HEX_RE.test(value.id);
  return false;
}
function validKey(value) {
  if (!exactKeys3(value, ["world", "kind", "id"]))
    return false;
  if (lessonKeyProblems(value).length > 0)
    return false;
  try {
    encodeLessonKey(value);
    return true;
  } catch {
    return false;
  }
}
function validTargetParts(value) {
  return validScope(value.scope) && validBinding(value.binding) && validKey(value.key) && value.key.world === value.scope.world;
}
function identityKeys(value, keys) {
  if (!isRecord7(value))
    return false;
  const withOrigin = Object.hasOwn(value, "installationId");
  if (withOrigin && (typeof value.installationId !== "string" || !UUID_RE.test(value.installationId)))
    return false;
  if (withOrigin && isRecord7(value.binding) && value.binding.kind === "installation" && value.installationId !== value.binding.id)
    return false;
  return exactKeys3(value, withOrigin ? [...keys, "installationId"] : keys);
}
function validTarget(value) {
  return identityKeys(value, ["scope", "binding", "key"]) && validTargetParts(value);
}
function validExpected(value, target) {
  if (value !== null && (typeof value !== "string" || !UUID_RE.test(value)))
    return false;
  if (target === null)
    return value === null;
  const origin = installationOf(target);
  return origin === null || value === origin;
}
function validModeFor(mode, target) {
  if (target === null)
    return mode === null;
  if (mode === "existing")
    return true;
  return mode === "capture" && target.key.kind === "capture";
}
function validSource(value) {
  if (!exactKeys3(value, SOURCE_FIELDS))
    return false;
  if (value.kind !== "native_selection" && value.kind !== "explicit_quote")
    return false;
  if (typeof value.quoteRedacted !== "boolean")
    return false;
  const sized = (text, max) => text === null || typeof text === "string" && isWellFormed(text) && utf8Bytes(text) <= max;
  if (!sized(value.quote, MAX_QUOTE_BYTES) || !sized(value.reference, MAX_REFERENCE_BYTES))
    return false;
  const ids = [value.captureSessionId, value.sourceConversationId, value.sourceRowId, value.sourceAgentId];
  return ids.every((id) => id === null || typeof id === "string" && SOURCE_ID_RE.test(id));
}
function validNavigation(value) {
  if (!isRecord7(value))
    return false;
  if (value.type === "close")
    return exactKeys3(value, ["type"]);
  if (value.type === "open-lesson")
    return exactKeys3(value, ["type", "scope", "binding", "key"]) && validTargetParts(value);
  if (value.type === "open-capture") {
    return exactKeys3(value, ["type", "scope", "binding", "recordId", "source"]) && validScope(value.scope) && validBinding(value.binding) && typeof value.recordId === "string" && UUID_RE.test(value.recordId) && validSource(value.source);
  }
  return false;
}
function validView(value) {
  return exactKeys3(value, [
    "key",
    "scope",
    "revision",
    "important",
    "effectiveText",
    "originalText",
    "source",
    "sourceStatus",
    "sourceDigest",
    "baselineDigest",
    "relatedPattern",
    "created",
    "updated"
  ]) && validKey(value.key) && validScope(value.scope) && isRevision2(value.revision) && typeof value.important === "boolean" && isStringOrNull(value.effectiveText) && isStringOrNull(value.originalText) && (value.source === null || validSource(value.source)) && SOURCE_STATUSES.includes(value.sourceStatus) && isDigestOrNull(value.sourceDigest) && isDigestOrNull(value.baselineDigest) && isStringOrNull(value.relatedPattern) && typeof value.created === "string" && typeof value.updated === "string";
}
function validRevisionEntry(value) {
  return exactKeys3(value, ["revision", "kind", "at", "text", "important", "oldSourceDigest", "newSourceDigest"]) && isRevision2(value.revision) && REVISION_KINDS2.includes(value.kind) && typeof value.at === "string" && isStringOrNull(value.text) && (value.important === null || typeof value.important === "boolean") && isDigestOrNull(value.oldSourceDigest) && isDigestOrNull(value.newSourceDigest);
}
function validBase(value, mode) {
  if (!exactKeys3(value, ["revision", "text", "important", "source"]))
    return false;
  if (!isRevision2(value.revision) || typeof value.text !== "string" || typeof value.important !== "boolean")
    return false;
  return value.source === null || mode === "capture" && validSource(value.source);
}
function validDraft(value, mode) {
  if (!exactKeys3(value, ["text", "source"]))
    return false;
  if (typeof value.text !== "string" || !isWellFormed(value.text) || utf8Bytes(value.text) > MAX_DRAFT_BYTES)
    return false;
  if (value.source === null)
    return true;
  return mode === "capture" && validSource(value.source);
}
function validError(value) {
  return exactKeys3(value, ["code", "fields"]) && (isCurationCode(value.code) || value.code === "EDITOR_SATURATED" || value.code === "STORE_UNRESOLVED") && Array.isArray(value.fields) && value.fields.length <= 32 && value.fields.every((field) => typeof field === "string" && field.length <= 128);
}
function validIdentity(value, extra = []) {
  return identityKeys(value, ["requestId", "binding", "scope", "key", ...extra]) && isRequestId(value.requestId) && validTargetParts(value);
}
function validPending(value, target) {
  if (!validIdentity(value, ["generation", "mutation"]))
    return false;
  const pending = value;
  if (!isRevision2(pending.generation) || !sameTarget(pending, target))
    return false;
  return pending.mutation === null || validMutation(pending.mutation, pending.requestId, target);
}
function validMutation(value, requestId, target) {
  if (!exactKeys3(value, ["requestId", "binding", "scope", "key", "expectedRevision", "change"]))
    return false;
  if (value.requestId !== requestId || !isRevision2(value.expectedRevision))
    return false;
  if (!validTargetParts(value) || !sameTarget(value, target))
    return false;
  const change = value.change;
  if (!isRecord7(change))
    return false;
  switch (change.kind) {
    case "capture":
      return exactKeys3(change, ["kind", "text", "source"]) && typeof change.text === "string" && validSource(change.source);
    case "edit":
      return exactKeys3(change, ["kind", "text"]) && typeof change.text === "string";
    case "important":
      return exactKeys3(change, ["kind", "value"]) && typeof change.value === "boolean";
    case "acknowledge-source":
      return exactKeys3(change, ["kind", "digest"]) && typeof change.digest === "string" && SHA256_HEX_RE.test(change.digest);
    case "purge":
      return exactKeys3(change, ["kind", "confirmed"]) && change.confirmed === true;
    default:
      return false;
  }
}
function parseUnresolved(value) {
  if (!Array.isArray(value) || value.length > MAX_UNRESOLVED)
    return null;
  if (!value.every((item) => validIdentity(item)))
    return null;
  const items = value;
  if (new Set(items.map((item) => item.requestId)).size !== items.length)
    return null;
  return items.map(copyIdentity);
}
function parseTombstones(value) {
  if (!Array.isArray(value) || value.length > MAX_TOMBSTONES)
    return null;
  if (!value.every((item) => validTarget(item)))
    return null;
  return value.map(copyTarget);
}
function invalid(field) {
  return { code: "INVALID_INPUT", fields: [field] };
}
function saturated(field) {
  return { code: "EDITOR_SATURATED", fields: [field] };
}
function sameKey(a, b) {
  return isRecord7(a) && a.world === b.world && a.kind === b.kind && a.id === b.id;
}
function sameBinding(a, b) {
  return isRecord7(a) && a.kind === b.kind && a.id === b.id;
}
function sameScope(a, b) {
  if (!isRecord7(a) || a.world !== b.world || !isRecord7(a.project))
    return false;
  const p = a.project;
  if (p.kind !== b.project.kind)
    return false;
  return b.project.kind !== "project" || p.id === b.project.id;
}
function sameTarget(a, b) {
  return isRecord7(a) && sameBinding(a.binding, b.binding) && sameScope(a.scope, b.scope) && sameKey(a.key, b.key);
}
function recordRelation(a, b) {
  const ai = installationOf(a);
  const bi = installationOf(b);
  if (ai !== null && bi !== null)
    return ai === bi ? "same" : "distinct";
  return "unknown";
}
function sameCanonicalTarget(_state, a, b) {
  return sameTarget(a, b);
}
function sameRecord(_state, a, b) {
  return sameKey(a.key, b.key) && recordRelation(a, b) === "same";
}
function isTombstoned(state, record) {
  return state.tombstones.some((item) => sameRecord(state, item, record));
}
function isStoreUnresolved(state, record) {
  const related = [...state.tombstones, ...state.unresolved];
  return related.some((item) => sameKey(item.key, record.key) && recordRelation(item, record) === "unknown");
}
function storeUnresolved() {
  return { code: "STORE_UNRESOLVED", fields: ["binding"] };
}
function validResolution(value) {
  return exactKeys3(value, ["location", "installation"]) && validBinding(value.location) && value.location.kind === "location" && validBinding(value.installation) && value.installation.kind === "installation";
}
function parseResolutions(value) {
  if (!Array.isArray(value) || value.length > MAX_RESOLUTIONS)
    return null;
  if (!value.every(validResolution))
    return null;
  const items = value;
  if (new Set(items.map((item) => item.location.id)).size !== items.length)
    return null;
  return items.map(copyResolution);
}
function copyResolution(item) {
  return { location: { kind: "location", id: item.location.id }, installation: { kind: "installation", id: item.installation.id } };
}
function sameSourceOrNull(a, b) {
  if (a === null || b === null)
    return a === b;
  return SOURCE_FIELDS.every((field) => a[field] === b[field]);
}
function baseFromView(view) {
  return { revision: view.revision, text: view.effectiveText ?? view.originalText ?? "", important: view.important, source: null };
}
function copyScope(scope) {
  return { world: scope.world, project: { ...scope.project } };
}
function copyTarget(target) {
  return {
    scope: copyScope(target.scope),
    binding: { ...target.binding },
    key: { ...target.key },
    ...target.installationId === undefined ? {} : { installationId: target.installationId }
  };
}
function copyIdentity(item) {
  return { requestId: item.requestId, ...copyTarget(item) };
}
function copyBase(base) {
  return { ...base, source: base.source === null ? null : { ...base.source } };
}
function copyDraft(draft) {
  return { text: draft.text, source: draft.source === null ? null : { ...draft.source } };
}
function copyNavigation(nav) {
  if (nav.type === "close")
    return { type: "close" };
  if (nav.type === "open-lesson")
    return { type: "open-lesson", scope: copyScope(nav.scope), binding: { ...nav.binding }, key: { ...nav.key } };
  return {
    type: "open-capture",
    scope: copyScope(nav.scope),
    binding: { ...nav.binding },
    recordId: nav.recordId,
    source: { ...nav.source }
  };
}
function copyChange(change) {
  return change.kind === "capture" ? { ...change, source: { ...change.source } } : { ...change };
}
function copyMutation(mutation) {
  return {
    requestId: mutation.requestId,
    binding: { ...mutation.binding },
    scope: copyScope(mutation.scope),
    key: { ...mutation.key },
    expectedRevision: mutation.expectedRevision,
    change: copyChange(mutation.change)
  };
}

// packages/core/src/lesson-curation-wire.ts
var CURATION_MUTATION_OPS = Object.freeze({
  "lessons.capture": "capture",
  "lessons.edit": "edit",
  "lessons.setImportant": "important",
  "lessons.acknowledgeSource": "acknowledge-source",
  "lessons.purge": "purge"
});
var OP_FOR_KIND = Object.freeze(Object.fromEntries(Object.entries(CURATION_MUTATION_OPS).map(([op, kind]) => [kind, op])));
function curationOpFor(kind) {
  return typeof kind === "string" && Object.hasOwn(OP_FOR_KIND, kind) ? OP_FOR_KIND[kind] : undefined;
}
function preconditionOk(p) {
  if (p === null || typeof p !== "object")
    return false;
  if (p.kind === "installation")
    return typeof p.id === "string" && UUID_RE.test(p.id);
  if (p.kind === "uninitialized")
    return typeof p.locationId === "string" && SHA256_HEX_RE.test(p.locationId);
  return false;
}
function projectRootFor(m, project) {
  const scope = m.scope?.project;
  const projectCapture = m.change.kind === "capture" && scope?.kind === "project";
  if (!projectCapture) {
    if (project !== null)
      throw new CurationError("INVALID_INPUT", ["project"]);
    return null;
  }
  if (project === null || project.world !== m.scope.world || project.projectId !== scope.id || typeof project.root !== "string" || project.root.length === 0) {
    throw new CurationError("INVALID_INPUT", ["project"]);
  }
  return project.root;
}
function toCurationMutationEnvelope(prepared, project) {
  const { mutation, precondition } = prepared;
  if (typeof mutation?.requestId !== "string" || !CURATION_REQUEST_ID_RE.test(mutation.requestId))
    throw new CurationError("INVALID_INPUT", ["requestId"]);
  if (!preconditionOk(precondition))
    throw new CurationError("INVALID_INPUT", ["precondition"]);
  const change = mutation.change;
  const op = curationOpFor(change?.kind);
  if (op === undefined)
    throw new CurationError("INVALID_INPUT", ["change.kind"]);
  if (op === "lessons.purge" && change?.confirmed !== true)
    throw new CurationError("INVALID_INPUT", ["change.confirmed"]);
  const args = { v: 1, mutation, precondition, projectRoot: projectRootFor(mutation, project) };
  return { version: 1, requestId: mutation.requestId, mutation: { op, args, confirmed: op === "lessons.purge" } };
}

// packages/core/src/sensitive-text.ts
var SECRET_RE = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|(api[_-]?key|secret|token|password)\s*[:=]\s*['"]?[A-Za-z0-9/+_-]{16,})/i;
function containsSensitiveText(text) {
  return SECRET_RE.test(text) || redactCredentials(text) !== text;
}

// apps/hook-module/src/ui/transport.ts
var CONTROL_TIMEOUT_MS = 1e4;

class ControlTransportError extends Error {
  name = "ControlTransportError";
  code;
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
function transportError(code, message) {
  throw new ControlTransportError(code, message);
}
async function runControlProcess($, requestJson) {
  if (utf8ByteLength(requestJson) > CONTROL_MAX_REQUEST_BYTES) {
    transportError("request_too_large", `The control request is over ${CONTROL_MAX_REQUEST_BYTES} bytes.`);
  }
  const root = $.plugin.root;
  let result;
  try {
    result = await $.process.run(["/bin/sh", `${root}/scripts/sil`, "ops"], {
      env: { SIL_PLUGIN_ROOT: root },
      stdin: requestJson,
      timeoutMs: CONTROL_TIMEOUT_MS
    });
  } catch {
    return transportError("launch_failed", `The control bridge did not start, or did not finish within ${CONTROL_TIMEOUT_MS / 1000} s.`);
  }
  if (result.isStdoutTruncated || result.isStderrTruncated) {
    transportError("truncated", "The control bridge wrote more output than the engine keeps; nothing was decoded.");
  }
  if (result.exitCode !== 0) {
    const code = Number.isInteger(result.exitCode) ? String(result.exitCode) : "an unknown code";
    transportError("exit_nonzero", `The control bridge exited with ${code}.`);
  }
  const stdout = result.stdout;
  if (!stdout.endsWith(`
`))
    transportError("incomplete", "The control bridge ended without a complete response.");
  const text = stdout.slice(0, -1);
  if (utf8ByteLength(text) > CONTROL_MAX_RESPONSE_BYTES) {
    transportError("response_too_large", `The control response is over ${CONTROL_MAX_RESPONSE_BYTES} bytes.`);
  }
  return text;
}
async function readControl($, request) {
  let checked;
  let requestJson;
  try {
    const encoded = JSON.stringify(parseControlRequest(request));
    checked = parseControlRequest(JSON.parse(encoded));
    requestJson = JSON.stringify(checked);
  } catch {
    return transportError("invalid_request", "The control request is malformed and was not sent.");
  }
  const text = await runControlProcess($, requestJson);
  let response;
  try {
    response = decodeControlResponse(text, checked.requestId);
  } catch (err) {
    if (err instanceof Error && err.message === "response: requestId does not match the request") {
      return transportError("request_mismatch", "The control response answers a different request.");
    }
    return transportError("malformed_response", "The control bridge returned a response that is not a valid envelope.");
  }
  const ids = Object.keys(response.results);
  const complete = ids.length === checked.reads.length && checked.reads.every((read) => Object.hasOwn(response.results, read.id));
  if (!complete)
    transportError("result_mismatch", "The control response does not answer exactly the reads that were asked.");
  return response;
}
async function mutateControl($, envelope) {
  let checked;
  try {
    checked = parseMutationRequestEnvelope(JSON.parse(JSON.stringify(parseMutationRequestEnvelope(envelope))));
  } catch {
    return transportError("invalid_request", "The control request is malformed and was not sent.");
  }
  if (utf8ByteLength(JSON.stringify(checked)) > MUTATION_MAX_REQUEST_BYTES) {
    transportError("request_too_large", `The control request is over ${MUTATION_MAX_REQUEST_BYTES} bytes and was not sent.`);
  }
  let requestJson;
  try {
    requestJson = encodeMutationRequestEnvelope(checked);
  } catch {
    return transportError("invalid_request", "The control request is malformed and was not sent.");
  }
  const requestId = checked.requestId;
  try {
    return decodeCurationMutationResponse(await runControlProcess($, requestJson), requestId);
  } catch {
    return { version: 1, requestId, error: { ...OUTCOME_UNKNOWN_ERROR }, conflict: null };
  }
}

// apps/hook-module/src/ui/lessons.ts
var LESSON_FILTERS = ["saved", "inbox", "archived", "important"];
var LESSONS_PAGE_SIZE = 10;
var MAX_FIELD_CHARS = 8192;
var HISTORY_PAGE_SIZE = 10;
var SOURCE_ID_RE2 = /^[A-Za-z0-9._:-]{1,128}$/;
var AGENT_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
function freshData() {
  return {
    controller: new LessonEditorController,
    epoch: null,
    ctx: 0,
    open: false,
    world: null,
    store: null,
    locationId: null,
    pinned: null,
    block: null,
    handshakeError: null,
    choices: [],
    contextNote: null,
    project: null,
    filter: "saved",
    search: "",
    list: null,
    listError: null,
    detail: null,
    detailError: null,
    notice: null,
    captureNote: null,
    pendingCapture: null,
    prompt: null,
    purgeConfirm: null,
    purgeCheck: null,
    pendingPrefill: null,
    scopeConfirm: null,
    scopeUnverified: false,
    projectOffset: 0,
    pageCursor: null,
    pageBack: [],
    searchDraft: null,
    persistWarning: null,
    captureExists: false,
    restoreNote: null,
    refused: {},
    dropped: {},
    reading: 0,
    refreshing: null,
    rev: 0
  };
}
var data = freshData();
var writes = Promise.resolve();
var readSeq = 0;
var listSeq = 0;
var resumed = false;
function resetLessonsForTests() {
  data = freshData();
  writes = Promise.resolve();
  readSeq = 0;
  listSeq = 0;
  resumed = false;
}
function lessonsViewModel() {
  const c = data.controller;
  const editor = c.state;
  let canRetry = false;
  if (editor.pending !== null && !c.sending) {
    try {
      c.prepare(editor.pending.requestId);
      canRetry = true;
    } catch {
      canRetry = false;
    }
  }
  return {
    open: data.open,
    world: data.world,
    editor,
    dirty: c.dirty,
    sending: c.sending,
    canRetry,
    store: data.store,
    block: data.block,
    handshakeError: data.handshakeError,
    choices: data.choices,
    contextNote: data.contextNote,
    project: data.project,
    filter: data.filter,
    search: data.search,
    list: data.list,
    listError: data.listError,
    detail: data.detail,
    detailError: data.detailError,
    notice: data.notice,
    captureNote: data.captureNote,
    pendingCapture: data.pendingCapture !== null,
    prompt: data.prompt,
    purgeConfirm: data.purgeConfirm === null ? null : { ...data.purgeConfirm },
    scopeToConfirm: scopeToConfirm(),
    projectOffset: data.projectOffset,
    page: data.pageBack.length + 1,
    searchDraft: data.searchDraft,
    persistWarning: data.persistWarning,
    purgeCheck: data.purgeCheck,
    captureExists: data.captureExists,
    restoreNote: data.restoreNote,
    refused: { ...data.refused },
    dropped: { ...data.dropped },
    reading: data.reading > 0
  };
}
function lessonsDirty() {
  return data.controller.dirty;
}
function textOk(value, max) {
  return value === null || value === undefined || typeof value === "string" && utf8Bytes(value) <= max && !containsSensitiveText(value);
}
function sourceOk(source) {
  if (source === null || typeof source !== "object")
    return true;
  const s = source;
  return textOk(s.quote, MAX_QUOTE_BYTES) && textOk(s.reference, MAX_REFERENCE_BYTES);
}
function screenRestore(exported) {
  const trimmed = {
    ...exported,
    loaded: null,
    history: null,
    pending: exported.pending === null ? null : { ...exported.pending, mutation: null }
  };
  const texts = [
    [trimmed.base?.text ?? null, MAX_TEXT_BYTES],
    [trimmed.draft?.text ?? null, MAX_TEXT_BYTES]
  ];
  const sizeOk = texts.every(([t, max]) => t === null || typeof t === "string" && utf8Bytes(t) <= max);
  const sources = [trimmed.base?.source ?? null, trimmed.draft?.source ?? null, trimmed.blocked?.type === "open-capture" ? trimmed.blocked.source : null];
  const sourceSizes = sources.every((s) => s === null || utf8Bytes(s.quote ?? "") <= MAX_QUOTE_BYTES && utf8Bytes(s.reference ?? "") <= MAX_REFERENCE_BYTES);
  if (!sizeOk || !sourceSizes)
    return { restore: null, withheld: "size" };
  const clean = texts.every(([t]) => typeof t !== "string" || !containsSensitiveText(t)) && sources.every(sourceOk);
  if (!clean)
    return { restore: null, withheld: "sensitive" };
  return { restore: JSON.parse(JSON.stringify(trimmed)), withheld: null };
}
function published() {
  const screened = screenRestore(data.controller.exportForRestore());
  const search = data.search.length <= CURATION_MAX_SEARCH_CHARS && !containsSensitiveText(data.search) ? data.search : "";
  return {
    version: 1,
    rev: data.rev,
    open: data.open,
    world: data.world,
    filter: data.filter,
    project: data.project === null ? null : flatProject(data.project),
    search,
    restore: screened.restore,
    withheld: screened.withheld,
    snapshot: JSON.parse(JSON.stringify(data.controller.snapshot()))
  };
}
var PUBLISH_ATTEMPTS = 2;
var PERSIST_WARNING = "The lesson editor could not be kept in session state. Unsent wording is still here, but a reload of the plugin would bring back older wording or none.";
function publish($) {
  data.rev += 1;
  const value = published();
  const run = async () => {
    for (let attempt = 0;attempt < PUBLISH_ATTEMPTS; attempt++) {
      try {
        const set = await $.state.set({ plugin: "self-improvement-loop", key: "lessons" }, value);
        if (set.isSet) {
          data.persistWarning = null;
          return;
        }
      } catch {}
    }
    if (data.persistWarning === null) {
      data.persistWarning = PERSIST_WARNING;
      try {
        $.ui.log(`self-improvement-loop: ${PERSIST_WARNING}`);
      } catch {}
    }
  };
  const result = writes.then(run, run);
  writes = result.catch(() => {
    return;
  });
  return result.catch(() => {
    return;
  });
}
var PUBLISHED_KEYS = ["version", "rev", "open", "world", "filter", "project", "search", "restore", "withheld", "snapshot"];
function parsePublishedLessons(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return null;
  const v = value;
  const own = Object.keys(v);
  if (own.length !== PUBLISHED_KEYS.length || !PUBLISHED_KEYS.every((k) => Object.hasOwn(v, k)))
    return null;
  if (v.version !== 1 || typeof v.rev !== "number" || !Number.isSafeInteger(v.rev) || v.rev < 0)
    return null;
  if (typeof v.open !== "boolean" || !(v.world === null || typeof v.world === "string"))
    return null;
  if (!LESSON_FILTERS.includes(v.filter))
    return null;
  if (!(v.project === null || typeof v.project === "string" && parseFlatProject(v.project) !== null))
    return null;
  if (typeof v.search !== "string" || v.search.length > CURATION_MAX_SEARCH_CHARS)
    return null;
  if (!(v.withheld === null || v.withheld === "sensitive" || v.withheld === "size"))
    return null;
  if (v.withheld !== null && v.restore !== null)
    return null;
  return v;
}
async function resumeLessons($) {
  if (resumed)
    return;
  resumed = true;
  const held = await $.state.get({ plugin: "self-improvement-loop", key: "lessons" });
  if (held.value === undefined)
    return;
  const parsed = parsePublishedLessons(held.value);
  data = freshData();
  data.epoch = newEpoch();
  data.controller.connect(data.epoch);
  if (parsed === null) {
    data.restoreNote = "The lesson editor's state from before the reload was unreadable and was reset. Nothing was saved or sent.";
    await publish($);
    return;
  }
  data.open = parsed.open;
  data.world = parsed.world;
  data.filter = parsed.filter;
  data.project = parsed.project === null ? null : parseFlatProject(parsed.project);
  data.scopeUnverified = data.project !== null;
  data.search = parsed.search;
  data.rev = parsed.rev;
  if (parsed.restore !== null) {
    data.controller.dispatch({ type: "restore", state: parsed.restore });
    if (data.controller.state.error?.fields.includes("state")) {
      resetController();
      data.restoreNote = "The lesson editor's state from before the reload was refused as invalid and was reset. Nothing was saved or sent.";
    }
  } else if (parsed.snapshot !== null && parsed.snapshot !== undefined) {
    data.controller.dispatch({ type: "hydrate", snapshot: parsed.snapshot });
    if (data.controller.state.error?.fields.includes("snapshot")) {
      resetController();
      data.restoreNote = "The lesson editor's state from before the reload was refused as invalid and was reset. Nothing was saved or sent.";
    } else if (parsed.withheld !== null) {
      data.restoreNote = parsed.withheld === "sensitive" ? "Unsent wording was not kept across the reload because it may hold a secret. Request ids were kept." : "Unsent wording was not kept across the reload because it was over the save limit. Request ids were kept.";
    }
  }
  await publish($);
}
function resetController() {
  data.controller = new LessonEditorController;
  data.epoch = newEpoch();
  data.controller.connect(data.epoch);
}
function newEpoch() {
  return `native-${crypto.randomUUID()}`;
}
function ensureConnected() {
  if (data.epoch === null) {
    data.epoch = newEpoch();
    data.controller.connect(data.epoch);
  }
}
async function lessonRead($, op, args, decode, isCurrent = () => true) {
  const ctx = data.ctx;
  const controller = data.controller;
  const epoch = data.epoch;
  const current = () => ctx === data.ctx && controller === data.controller && epoch === data.epoch && isCurrent();
  readSeq += 1;
  data.reading += 1;
  try {
    let value;
    try {
      const response = await readControl($, { version: 1, requestId: `sil-lesson-${readSeq}`, reads: [{ id: "r", op, args }] });
      const result = response.results["r"];
      if (result === undefined)
        throw new CurationReadError("MALFORMED", null);
      if (!result.ok)
        throw new CurationReadError(typeof result.error.code === "string" ? result.error.code : "MALFORMED", null);
      value = decode(result.value);
    } catch (err) {
      if (!current())
        return { ok: false, stale: true };
      return { ok: false, stale: false, error: err instanceof CurationReadError ? err : new CurationReadError("TRANSPORT", null) };
    }
    if (!current())
      return { ok: false, stale: true };
    const binding = args["binding"];
    if (binding !== undefined) {
      const store = value.store;
      if (store === undefined)
        return { ok: false, stale: false, error: new CurationReadError("MALFORMED", null) };
      const id = binding.slice(binding.indexOf(":") + 1);
      const matches = binding.startsWith("installation:") ? store.installationId === id : store.locationId === id;
      if (!matches)
        return { ok: false, stale: false, error: new CurationReadError("INSTALLATION_MISMATCH", null) };
      if (binding.startsWith("location:") && op !== "lessons.projects" && op !== "lessons.receipt" && data.pinned === null && store.installationId !== null) {
        return { ok: false, stale: false, error: new CurationReadError("STORE_CHANGED", null) };
      }
    }
    return { ok: true, value };
  } finally {
    data.reading -= 1;
  }
}
function installationOf2(t) {
  return t.binding.kind === "installation" ? t.binding.id : t.installationId ?? null;
}
function currentBinding() {
  if (data.block !== null)
    return null;
  if (data.pinned !== null)
    return { kind: "installation", id: data.pinned };
  return data.store?.state === "uninitialized" && data.locationId !== null ? { kind: "location", id: data.locationId } : null;
}
function recordReadBinding(target) {
  const proven = installationOf2(target) ?? data.controller.state.expectedInstallation;
  return proven === null ? target.binding : { kind: "installation", id: proven };
}
function blockFor(current) {
  const editor = data.controller.state;
  const expected = editor.target !== null ? editor.expectedInstallation : null;
  if (expected !== null && current !== expected)
    return "Different SIL installation. Nothing from it is shown or saved here.";
  const pending = editor.pending;
  if (expected === null && pending !== null && installationOf2(pending) === null && current !== null) {
    return "An earlier save went to a store that has since been set up. Check its outcome before browsing.";
  }
  if (expected === null && data.pinned !== null && current !== data.pinned)
    return "Different SIL installation. Nothing from it is shown or saved here.";
  return null;
}
async function handshake($) {
  const world = data.world;
  if (world === null)
    return false;
  ensureConnected();
  data.handshakeError = null;
  const status = await lessonRead($, "lessons.store", {}, decodeStoreStatus);
  if (!status.ok) {
    if (!status.stale)
      data.handshakeError = readMessage(status.error);
    return false;
  }
  if (status.value.state === "error") {
    data.handshakeError = `Curation storage is unavailable (${status.value.code}).`;
    return false;
  }
  const flat = status.value.state === "ready" ? `installation:${status.value.installationId}` : `location:${status.value.locationId}`;
  const projects = await lessonRead($, "lessons.projects", { world, binding: flat }, (v) => decodeReadResult(v, decodeProjects));
  if (!projects.ok) {
    if (!projects.stale)
      data.handshakeError = readMessage(projects.error);
    return false;
  }
  const result = projects.value;
  if (status.value.state === "ready" && result.store.installationId !== status.value.installationId) {
    data.handshakeError = "The store changed while loading. Refresh to try again.";
    return false;
  }
  if (!result.value.every((choice) => choice.scope.world === world)) {
    data.handshakeError = "The store sent projects for another world.";
    return false;
  }
  const current = result.store.installationId;
  const block = blockFor(current);
  if (block === null && data.pinned === null)
    data.pinned = data.controller.state.expectedInstallation ?? current;
  data.store = current === null ? { state: "uninitialized", locationId: result.store.locationId } : { state: "ready", installationId: current };
  data.locationId = result.store.locationId;
  data.block = block;
  data.choices = block === null ? result.value : [];
  if (block !== null) {
    data.list = null;
    data.detail = null;
  }
  data.controller.observe({ connectionEpoch: data.epoch, binding: { kind: "location", id: result.store.locationId }, installationId: current, pinnedLocationRetry: true });
  return block === null;
}
function decodeContext(value) {
  if (value === null || typeof value !== "object")
    throw new CurationReadError("MALFORMED", null);
  const v = value;
  if (v.state === "resolved")
    return { scope: decodeScope(v.scope), requiresConfirmation: v.requiresConfirmation === true };
  if (v.state === "choice_required" && typeof v.reason === "string")
    return { choice: v.reason };
  throw new CurationReadError("MALFORMED", null);
}
async function adoptContext($) {
  if (data.world === null)
    return;
  const restored = data.project;
  if (restored !== null && !data.scopeUnverified)
    return;
  let cwd;
  try {
    cwd = await $.session.cwd();
  } catch {
    if (restored === null)
      data.contextNote = "This session's directory is unknown. Choose a project.";
    return;
  }
  if (cwd === "")
    return;
  const world = data.world;
  const read = await lessonRead($, "lessons.context", { world, cwd }, decodeContext);
  if (!read.ok) {
    if (!read.stale && restored === null)
      data.contextNote = `This directory's project could not be resolved: ${readMessage(read.error)} Choose one.`;
    return;
  }
  const ctx = read.value;
  if (restored !== null) {
    if ("choice" in ctx || ctx.scope.world !== world || !sameProject(ctx.scope.project, restored) || data.project !== restored)
      return;
    data.scopeUnverified = false;
    data.scopeConfirm = ctx.requiresConfirmation ? { world, project: flatProject(restored), confirmed: false } : null;
    if (ctx.requiresConfirmation)
      data.contextNote = "This world was inferred as the catch-all for this directory. A capture here waits for you to confirm the world and project.";
    return;
  }
  if ("choice" in ctx) {
    data.contextNote = "This directory does not map to one project. Choose one.";
    return;
  }
  if (ctx.scope.world !== data.world || !data.choices.some((c) => sameProject(c.scope.project, ctx.scope.project))) {
    data.contextNote = "This directory's project is not among the choices. Choose one.";
    return;
  }
  data.project = ctx.scope.project;
  data.scopeConfirm = ctx.requiresConfirmation ? { world: data.world, project: flatProject(ctx.scope.project), confirmed: false } : null;
  data.contextNote = ctx.requiresConfirmation ? "This world was inferred as the catch-all for this directory. A capture here waits for you to confirm the world and project." : null;
}
function scopeToConfirm() {
  const c = data.scopeConfirm;
  const target = data.controller.state.target;
  if (target === null || data.controller.state.mode !== "capture")
    return null;
  if (data.scopeUnverified)
    return { world: target.scope.world, project: flatProject(target.scope.project), restored: true };
  if (c === null || c.confirmed)
    return null;
  if (target.scope.world !== c.world || flatProject(target.scope.project) !== c.project)
    return null;
  return { world: c.world, project: c.project, restored: false };
}
function resetPaging() {
  data.pageCursor = null;
  data.pageBack = [];
}
async function reloadList($, requested, moved) {
  const cursor = requested === undefined ? data.pageCursor : requested;
  const seq = requested === undefined ? listSeq : ++listSeq;
  const project = data.project;
  const binding = currentBinding();
  const world = data.world;
  if (project === null || binding === null || world === null)
    return;
  const filter = data.filter;
  const query = browseQuery({
    world,
    project,
    binding,
    collection: filter === "important" ? "all" : filter,
    ...filter === "important" ? { important: true } : {},
    search: data.search.trim(),
    limit: LESSONS_PAGE_SIZE,
    ...cursor !== null ? { cursor } : {}
  });
  const read = await lessonRead($, "lessons.browse", query, (v) => decodeReadResult(v, decodeBrowsePage));
  if (!read.ok) {
    if (!read.stale)
      data.listError = readMessage(read.error);
    return;
  }
  const page = read.value;
  if (data.block !== null || page.store.installationId !== data.pinned)
    return;
  if (!page.value.items.every((item) => item.key.world === world && item.scope.world === world && sameProject(item.scope.project, project))) {
    data.listError = "The store sent lessons for another project.";
    return;
  }
  const ctx = data.ctx;
  const readAt = await nowIso2($);
  if (seq !== listSeq || ctx !== data.ctx || data.block !== null || page.store.installationId !== data.pinned)
    return;
  if (requested === undefined && cursor !== data.pageCursor)
    return;
  data.list = { items: page.value.items, total: page.value.total, nextCursor: page.value.nextCursor, readAt };
  data.listError = null;
  moved?.();
}
async function nowIso2($) {
  try {
    return new Date(await $.clock.now()).toISOString();
  } catch {
    return "unknown time";
  }
}
async function loadDetail($) {
  if (data.block !== null)
    return null;
  const c = data.controller;
  const state = c.state;
  const target = state.target;
  if (target === null || state.phase === "purged")
    return null;
  const generation = state.generation;
  const epoch = data.epoch;
  const args = { key: encodeLessonKey(target.key), project: flatProject(target.scope.project), binding: flatBinding(recordReadBinding(target)) };
  const read = await lessonRead($, "lessons.get", args, (v) => decodeReadResult(v, (x) => x === null ? null : decodeLessonDetail(x)));
  if (!read.ok) {
    if (!read.stale && c.state.generation === generation)
      data.detailError = readMessage(read.error);
    return null;
  }
  const result = { operation: "read", connectionEpoch: epoch, generation, target, installationId: read.value.store.installationId };
  if (read.value.value === null) {
    c.dispatch({ type: "detail-missing", generation, target }, result);
    return null;
  }
  const lesson = read.value.value.lesson;
  c.dispatch({ type: "loaded", generation, target, view: lesson }, result);
  const accepted = c.state.generation === generation && c.state.loaded !== null && JSON.stringify(c.state.loaded) === JSON.stringify(lesson);
  if (!accepted)
    return null;
  const prior = data.detail;
  const keep = prior !== null && sameKey2(prior.key, lesson.key) && prior.revision === lesson.revision && prior.history !== null && !prior.historyError;
  data.detailError = null;
  data.detail = {
    key: lesson.key,
    revision: lesson.revision,
    provenance: read.value.value.provenance,
    diagnostics: read.value.value.diagnostics,
    history: keep ? prior.history : null,
    historyTotal: keep ? prior.historyTotal : null,
    historyError: false,
    readAt: await nowIso2($)
  };
  if (!keep) {
    const history = await lessonRead($, "lessons.history", { ...args, limit: String(HISTORY_PAGE_SIZE) }, (v) => decodeReadResult(v, decodeHistory));
    const shown = data.detail;
    if (shown !== null && sameKey2(shown.key, lesson.key) && shown.revision === lesson.revision) {
      data.detail = history.ok ? { ...shown, history: history.value.value.items, historyTotal: history.value.value.total } : history.stale ? shown : { ...shown, historyError: true };
    }
  }
  return c.state.loaded;
}
function refreshLessons($) {
  if (!data.open)
    return Promise.resolve();
  if (data.refreshing !== null)
    return data.refreshing;
  const run = (async () => {
    if (data.controller.sending || data.prompt !== null)
      return;
    if (!await handshake($))
      return;
    await adoptContext($);
    await reloadList($);
    const state = data.controller.state;
    if (state.target !== null && state.phase !== "purged" && (state.mode === "existing" || state.pending !== null || state.needsFreshDetail))
      await loadDetail($);
    if (state.target !== null && state.phase === "purged" && data.purgeCheck === "unavailable")
      await verifyPurged($, false);
  })().catch(() => {
    data.listError = "Lessons could not be read.";
  }).finally(() => {
    data.refreshing = null;
  }).then(() => publish($));
  data.refreshing = run;
  return run;
}
function validId(value, re) {
  return typeof value === "string" && re.test(value) ? value : null;
}
function emptySource(sessionId) {
  return {
    kind: "explicit_quote",
    quote: null,
    reference: null,
    quoteRedacted: false,
    captureSessionId: sessionId,
    sourceConversationId: null,
    sourceRowId: null,
    sourceAgentId: null
  };
}
async function readCaptureSelection($, view) {
  let sessionId = null;
  try {
    sessionId = validId(await $.session.id(), SOURCE_ID_RE2);
  } catch {
    sessionId = null;
  }
  let selected;
  try {
    selected = await $.ui.selection();
  } catch {
    return { source: emptySource(sessionId), note: "Selection unavailable. Paste the relevant passage or add a reference." };
  }
  const text = selected?.text;
  if (typeof text !== "string" || !isWellFormed(text) || !hasVisibleText(text)) {
    return { source: emptySource(sessionId), note: "Selection unavailable. Paste the relevant passage or add a reference." };
  }
  if (utf8Bytes(text) > MAX_QUOTE_BYTES) {
    return { source: emptySource(sessionId), note: `The selection is over ${MAX_QUOTE_BYTES} bytes and was not used. Paste a shorter passage or add a reference.` };
  }
  if (containsSensitiveText(text)) {
    return { source: emptySource(sessionId), note: "The selection looks like it holds a secret and was not used. Paste the passage without it, or add a reference." };
  }
  const row = validId(selected?.requestId, SOURCE_ID_RE2);
  const viewKnown = view !== null && typeof view === "object";
  const agent = viewKnown ? validId(view.agentId, AGENT_ID_RE) : null;
  const viewIsMain = viewKnown && view.agentId === undefined;
  return {
    source: {
      kind: "native_selection",
      quote: text,
      reference: null,
      quoteRedacted: false,
      captureSessionId: sessionId,
      sourceConversationId: row !== null && viewIsMain ? sessionId : null,
      sourceRowId: row,
      sourceAgentId: row !== null ? agent : null
    },
    note: row === null ? "Selected text kept as a quote; which transcript row it came from is not known." : viewKnown ? null : "Selected text kept with its row; which conversation it lies in is not known."
  };
}
var HELD_WHILE_SENDING = new Set([
  "project",
  "record",
  "capture",
  "close-editor",
  "open-existing",
  "rebase",
  "save",
  "important",
  "acknowledge",
  "purge",
  "purge-confirm",
  "retry",
  "discard",
  "confirm-scope"
]);
var SENDING_NOTICE = "A save is in flight: wait for it to finish before changing the lesson, its scope or the world.";
function lessonsAct($, action, world) {
  let switchWorld = null;
  return actOnce($, action, world, (w) => switchWorld = w).catch(() => {
    data.notice = { tone: "error", text: "That lesson action failed. Nothing was sent unless a save says so." };
  }).then(() => publish($)).then(() => ({ switchWorld }));
}
function rebindWorld(world) {
  if (world === data.world)
    return true;
  if (lessonsDirty()) {
    if (world !== null)
      data.prompt = { kind: "world", world };
    return false;
  }
  bindWorld(world);
  return true;
}
async function actOnce($, action, world, switchTo) {
  if (data.controller.sending && (HELD_WHILE_SENDING.has(action.kind) || world !== data.world)) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    return;
  }
  if (action.kind !== "stay" && action.kind !== "discard" && action.kind !== "close" && !rebindWorld(world))
    return;
  switch (action.kind) {
    case "open":
      data.open = true;
      await publish($);
      await refreshLessons($);
      return;
    case "close":
      data.open = false;
      return;
    case "refresh":
      await refreshLessons($);
      return;
    case "filter":
      if (data.filter === action.filter)
        return;
      data.filter = action.filter;
      data.ctx += 1;
      data.list = null;
      resetPaging();
      await reloadList($);
      return;
    case "project": {
      const project = parseFlatProject(action.project);
      if (project === null || !data.choices.some((c) => sameProject(c.scope.project, project)))
        return;
      if (data.project !== null && sameProject(data.project, project)) {
        data.scopeUnverified = false;
        if (data.scopeConfirm !== null && data.scopeConfirm.project === flatProject(project))
          data.scopeConfirm = { ...data.scopeConfirm, confirmed: true };
        return;
      }
      if (lessonsDirty()) {
        data.prompt = { kind: "project", project };
        return;
      }
      await applyProject($, project);
      return;
    }
    case "more": {
      const next = data.list?.nextCursor ?? null;
      if (next === null)
        return;
      const back = [...data.pageBack, data.pageCursor];
      data.ctx += 1;
      await reloadList($, next, () => {
        data.pageBack = back;
        data.pageCursor = next;
      });
      return;
    }
    case "prev": {
      if (data.pageBack.length === 0)
        return;
      const cursor = data.pageBack.at(-1) ?? null;
      const back = data.pageBack.slice(0, -1);
      data.ctx += 1;
      await reloadList($, cursor, () => {
        data.pageCursor = cursor;
        data.pageBack = back;
      });
      return;
    }
    case "first":
      if (data.pageBack.length === 0)
        return;
      data.ctx += 1;
      await reloadList($, null, resetPaging);
      return;
    case "projects":
      if (!Number.isSafeInteger(action.offset) || action.offset < 0 || action.offset >= Math.max(1, data.choices.length))
        return;
      data.projectOffset = action.offset;
      return;
    case "confirm-scope": {
      const pending = scopeToConfirm();
      if (pending === null)
        return;
      data.scopeUnverified = false;
      data.scopeConfirm = { world: pending.world, project: pending.project, confirmed: true };
      data.contextNote = null;
      return;
    }
    case "record": {
      const item = data.list?.items[action.index];
      if (item === undefined)
        return;
      await openRecord($, item.key, item.scope);
      return;
    }
    case "capture":
      await openCapture($, await readCaptureSelection($, action.view));
      return;
    case "close-editor":
      if (lessonsDirty()) {
        data.controller.dispatch({ type: "close" });
        return;
      }
      closeEditor();
      return;
    case "save": {
      const mode = data.controller.state.mode;
      await submit2($, { kind: "save" }, mode === "capture" ? "capture" : "edit");
      return;
    }
    case "important": {
      const base = data.controller.state.base;
      if (base === null)
        return;
      await submit2($, { kind: "important", value: !base.important }, "important");
      return;
    }
    case "acknowledge": {
      const digest = data.controller.state.loaded?.sourceDigest ?? null;
      if (digest === null)
        return;
      await submit2($, { kind: "acknowledge-source", digest }, "acknowledge-source");
      return;
    }
    case "purge": {
      const target = data.controller.state.target;
      data.purgeConfirm = target === null ? null : { ...target.key };
      return;
    }
    case "purge-cancel":
      data.purgeConfirm = null;
      return;
    case "purge-confirm": {
      const asked = data.purgeConfirm;
      data.purgeConfirm = null;
      const target = data.controller.state.target;
      if (asked === null || target === null || !sameKey2(asked, target.key)) {
        if (asked !== null)
          data.notice = { tone: "error", text: "The open lesson is not the one the purge question named. Nothing was purged." };
        return;
      }
      await submit2($, { kind: "purge", confirmed: true }, "purge");
      return;
    }
    case "stay":
      data.prompt = null;
      data.pendingPrefill = null;
      data.controller.dispatch({ type: "stay" });
      return;
    case "discard": {
      const prompt = data.prompt;
      data.prompt = null;
      if (prompt !== null) {
        if (!closeEditor(true))
          return;
        if (prompt.kind === "project")
          await applyProject($, prompt.project);
        else {
          bindWorld(prompt.world);
          switchTo(prompt.world);
        }
        return;
      }
      const before = data.controller.state.generation;
      data.controller.dispatch({ type: "discard" });
      const after = data.controller.state;
      const prefill = data.pendingPrefill;
      data.pendingPrefill = null;
      if (after.generation === before) {
        data.refused = {};
        data.dropped = {};
        return;
      }
      data.ctx += 1;
      clearRecordView();
      if (after.mode === "capture" && prefill !== null && after.target?.key.id === prefill.recordId) {
        data.captureNote = prefill.note;
        if (prefill.quote !== null)
          data.controller.dispatch({ type: "edit-text", text: prefill.quote });
      } else if (after.target !== null && after.mode === "existing")
        await loadDetail($);
      return;
    }
    case "rebase":
      data.controller.dispatch({ type: "rebase" });
      return;
    case "check":
      await checkOutcome($);
      return;
    case "retry": {
      const pending = data.controller.state.pending;
      if (pending !== null)
        await send($, pending.requestId, null);
      return;
    }
    case "open-existing": {
      const target = data.controller.state.target;
      if (target === null || !data.captureExists)
        return;
      await openRecord($, { ...target.key }, { world: target.scope.world, project: { ...target.scope.project } });
      return;
    }
  }
}
function lessonsInput($, field, value, kind) {
  const c = data.controller;
  if (field !== "search" && c.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    return publish($);
  }
  if (value.length > MAX_FIELD_CHARS) {
    if (field !== "search")
      data.dropped[field] = true;
    data.notice = { tone: "error", text: `That text is over ${MAX_FIELD_CHARS} characters and was not kept. Nothing was saved or searched.` };
    return publish($);
  }
  if (field !== "search")
    delete data.dropped[field];
  if (field === "search") {
    data.searchDraft = value;
    if (kind !== "submit")
      return Promise.resolve();
    if (value.length > CURATION_MAX_SEARCH_CHARS) {
      data.notice = { tone: "error", text: `Search is limited to ${CURATION_MAX_SEARCH_CHARS} characters. Nothing was searched.` };
      return publish($);
    }
    if (containsSensitiveText(value)) {
      data.notice = { tone: "error", text: "That search looks like it holds a secret and was not run." };
      return publish($);
    }
    data.search = value;
    data.searchDraft = null;
    data.ctx += 1;
    data.list = null;
    data.notice = null;
    resetPaging();
    return reloadList($).catch(() => {
      return;
    }).then(() => publish($));
  }
  if (field === "text") {
    c.dispatch({ type: "edit-text", text: value });
    noteRefusal("text", value, c.state.error?.fields.includes("text") === true);
    return publish($);
  }
  const source = c.state.draft?.source;
  if (!source)
    return Promise.resolve();
  const next = { ...source, ...field === "quote" ? { quote: value === "" ? null : value } : { reference: value === "" ? null : value } };
  c.dispatch({ type: "edit-source", source: next });
  noteRefusal(field, value, c.state.error?.fields.includes("source") === true);
  return publish($);
}
var FIELD_LIMITS = { text: MAX_TEXT_BYTES, quote: MAX_QUOTE_BYTES, reference: MAX_REFERENCE_BYTES };
function noteRefusal(field, value, refused) {
  if (refused)
    data.refused[field] = value;
  else
    delete data.refused[field];
  const over = Object.keys(data.refused);
  data.notice = over.length > 0 ? { tone: "error", text: `${over.map((f) => `The ${f === "text" ? "wording" : f} is over its ${FIELD_LIMITS[f]}-byte limit`).join(". ")}. Nothing is saved until it fits.` } : data.notice?.tone === "error" && data.notice.text.includes("-byte limit") ? null : data.notice;
}
function lessonsWorldChanging($, world) {
  if (data.world === null || data.world === world)
    return true;
  if (data.controller.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    publish($);
    return false;
  }
  const bound = rebindWorld(world);
  publish($);
  return bound;
}
function bindWorld(world) {
  if (data.world === world)
    return;
  if (data.controller.state.target !== null)
    closeEditor(true);
  data.world = world;
  data.ctx += 1;
  data.project = null;
  data.choices = [];
  data.list = null;
  data.scopeConfirm = null;
  data.scopeUnverified = false;
  data.projectOffset = 0;
  data.searchDraft = null;
  resetPaging();
  data.listError = null;
  data.contextNote = null;
  data.pendingCapture = null;
  data.captureNote = null;
  data.notice = null;
  data.prompt = null;
  data.pinned = null;
  data.store = null;
  data.block = null;
}
async function applyProject($, project) {
  const target = data.controller.state.target;
  if (target !== null && !sameProject(target.scope.project, project) && !closeEditor())
    return;
  data.project = project;
  data.ctx += 1;
  data.list = null;
  data.listError = null;
  data.contextNote = null;
  data.scopeConfirm = null;
  data.scopeUnverified = false;
  resetPaging();
  if (data.pendingCapture !== null) {
    const source = data.pendingCapture;
    data.pendingCapture = null;
    await openCapture($, { source, note: data.captureNote });
    return;
  }
  await reloadList($);
}
function clearRecordView() {
  data.refused = {};
  data.dropped = {};
  data.detail = null;
  data.detailError = null;
  data.purgeConfirm = null;
  data.purgeCheck = null;
  data.captureExists = false;
}
function closeEditor(discard = false) {
  const prior = data.controller.state;
  if (prior.target === null)
    return true;
  if (prior.gate === "mismatch") {
    if (!discard && data.controller.dirty)
      return false;
    const candidate = new LessonEditorController;
    const epoch = newEpoch();
    candidate.connect(epoch);
    candidate.dispatch({ type: "hydrate", snapshot: data.controller.snapshot() });
    if (candidate.state.error?.fields.includes("snapshot"))
      return false;
    candidate.dispatch({ type: "close" });
    if (candidate.state.target !== null)
      return false;
    data.controller = candidate;
    data.epoch = epoch;
  } else {
    data.controller.dispatch({ type: "close" });
    if (discard && data.controller.state.target !== null)
      data.controller.dispatch({ type: "discard" });
  }
  const closed = data.controller.state.target === null;
  if (closed) {
    data.ctx += 1;
    clearRecordView();
  } else {
    data.notice = { tone: "error", text: "The open lesson could not be set aside: too many unchecked saves. Nothing was changed." };
  }
  return closed;
}
async function openRecord($, key, scope) {
  const binding = currentBinding();
  if (binding === null)
    return;
  const before = data.controller.state.generation;
  data.controller.dispatch({ type: "open-lesson", scope, binding, key });
  const opened = data.controller.state;
  if (opened.generation === before || opened.target === null || !sameKey2(opened.target.key, key))
    return;
  data.ctx += 1;
  clearRecordView();
  data.notice = null;
  await loadDetail($);
}
async function openCapture($, selection) {
  if (data.controller.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    return;
  }
  if (data.world === null) {
    data.notice = { tone: "error", text: "Choose a world before capturing a lesson." };
    return;
  }
  if (currentBinding() === null || data.choices.length === 0)
    await handshake($);
  await adoptContext($);
  const binding = currentBinding();
  if (binding === null) {
    data.notice = { tone: "error", text: data.handshakeError ?? data.block ?? "The curation store is not known yet. Refresh and try again." };
    data.pendingCapture = selection.source;
    data.captureNote = selection.note;
    return;
  }
  if (data.project === null) {
    data.pendingCapture = selection.source;
    data.captureNote = selection.note;
    data.notice = { tone: "info", text: "Choose a project for this capture." };
    return;
  }
  const source = selection.source ?? emptySource(null);
  const recordId = crypto.randomUUID();
  const before = data.controller.state.generation;
  data.controller.dispatch({ type: "open-capture", scope: { world: data.world, project: data.project }, binding, recordId, source });
  const opened = data.controller.state;
  if (opened.generation === before || opened.mode !== "capture" || opened.target?.key.id !== recordId) {
    data.pendingPrefill = opened.generation === before ? { recordId, quote: source.quote, note: selection.note } : null;
    return;
  }
  data.ctx += 1;
  clearRecordView();
  data.captureNote = selection.note;
  data.notice = null;
  if (source.quote !== null)
    data.controller.dispatch({ type: "edit-text", text: source.quote });
}
async function openLessonCapture($, selection, world) {
  if (data.controller.sending) {
    data.notice = { tone: "error", text: SENDING_NOTICE };
    await publish($);
    return `The capture was held. ${SENDING_NOTICE}`;
  }
  data.open = true;
  if (!rebindWorld(world)) {
    await publish($);
    return "The lesson editor holds unsent wording for another world. Save or discard it first.";
  }
  await openCapture($, selection).catch(() => {
    data.notice = { tone: "error", text: "The capture form could not open." };
  });
  await publish($);
  return null;
}
async function openLessonByKey($, encoded, world) {
  let key;
  try {
    key = decodeLessonKey(encoded);
  } catch {
    return "That lesson key is not valid.";
  }
  if (world !== key.world)
    return `That lesson belongs to world ${JSON.stringify(key.world)}. Switch the console to it first.`;
  if (data.controller.sending)
    return SENDING_NOTICE;
  if (lessonsDirty())
    return "The lesson editor holds unsent wording. Save or discard it first.";
  if (!rebindWorld(world))
    return "The lesson editor holds unsent wording. Save or discard it first.";
  data.open = true;
  try {
    if (!await handshake($) || data.pinned === null) {
      await publish($);
      return data.handshakeError ?? data.block ?? "The curation store could not be read.";
    }
    const read = await lessonRead($, "lessons.locate", { key: encodeLessonKey(key), binding: `installation:${data.pinned}` }, (v) => decodeLocatedResult(v, data.pinned, key));
    if (!read.ok) {
      await publish($);
      return read.stale ? "The lesson view changed while looking it up." : readMessage(read.error);
    }
    const scope = read.value.value;
    if (scope === null) {
      await publish($);
      return "No lesson with this key in this installation.";
    }
    if (data.project === null || !sameProject(data.project, scope.project)) {
      data.project = scope.project;
      data.ctx += 1;
      data.list = null;
    }
    await openRecord($, key, scope);
    await reloadList($);
  } catch {
    await publish($);
    return "The lesson could not be opened.";
  }
  await publish($);
  return "Opened the lesson in the self-improvement loop console.";
}
function projectDescriptor() {
  const state = data.controller.state;
  const target = state.target;
  if (target === null || target.scope.project.kind !== "project" || state.mode !== "capture")
    return null;
  const project = target.scope.project;
  const choice = data.choices.find((c) => sameProject(c.scope.project, project));
  if (!choice || choice.root === null || data.world === null)
    return null;
  return { world: data.world, projectId: project.id, root: choice.root };
}
function sensitiveFields(intent) {
  if (intent.kind !== "save")
    return [];
  const draft = data.controller.state.draft;
  if (draft === null)
    return [];
  const fields = [];
  if (containsSensitiveText(draft.text))
    fields.push("wording");
  if (draft.source?.quote && containsSensitiveText(draft.source.quote))
    fields.push("quote");
  if (draft.source?.reference && containsSensitiveText(draft.source.reference))
    fields.push("reference");
  return fields;
}
async function submit2($, intent, readback) {
  if (data.block !== null)
    return;
  const unconfirmed = intent.kind === "save" ? scopeToConfirm() : null;
  if (unconfirmed !== null) {
    data.notice = { tone: "error", text: `Confirm the ${unconfirmed.restored ? "restored" : "inferred"} world and project before saving this capture. Nothing was sent.` };
    return;
  }
  if (intent.kind === "save" && Object.keys(data.dropped).length > 0) {
    data.notice = { tone: "error", text: "A field shows older text because what was typed there was too long and not kept. Edit that field before saving; nothing was sent." };
    return;
  }
  if (intent.kind === "save" && Object.keys(data.refused).length > 0) {
    data.notice = { tone: "error", text: "A field is over its limit. Shorten it; nothing was sent." };
    return;
  }
  const sensitive = sensitiveFields(intent);
  if (sensitive.length > 0) {
    data.notice = { tone: "error", text: `This looks like a secret in ${sensitive.join(", ")}. Remove it and save again. Nothing was sent.` };
    return;
  }
  const requestId = `lc_${crypto.randomUUID()}`;
  data.controller.dispatch({ type: "submit", requestId, intent });
  if (data.controller.state.pending?.requestId !== requestId)
    return;
  await send($, requestId, readback);
}
async function send($, requestId, readback) {
  const c = data.controller;
  let attempt;
  try {
    attempt = c.beginAttempt(requestId);
  } catch {
    return;
  }
  data.notice = null;
  data.captureExists = false;
  data.purgeCheck = null;
  await publish($);
  let completion;
  try {
    const envelope = toCurationMutationEnvelope(attempt.prepared, projectDescriptor());
    const response = await mutateControl($, envelope);
    if ("receipt" in response)
      completion = { kind: "success", store: { ...response.store }, receipt: response.receipt };
    else
      completion = classifyMutationFailure(response.error) === "refused" ? { kind: "refused", code: response.error.code, fields: [] } : { kind: "unknown" };
  } catch (err) {
    completion = err instanceof CurationError ? { kind: "refused", code: err.code, fields: [...err.fields] } : { kind: "refused", code: "INVALID_INPUT", fields: ["request"] };
  }
  c.finishAttempt(attempt.token, completion);
  if (c !== data.controller)
    return;
  await afterOutcome($, completion, readback);
}
async function afterOutcome($, completion, readback) {
  const state = data.controller.state;
  if (state.phase === "purged") {
    await verifyPurged($, readback === "purge");
    return;
  }
  if (state.phase === "conflict") {
    if (state.mode === "capture" && state.error?.code === "CAPTURE_EXISTS") {
      data.captureExists = true;
      return;
    }
    await loadDetail($);
    return;
  }
  if (completion.kind !== "success" || state.pending !== null || completion.receipt.state !== "completed")
    return;
  const committed = completion.receipt.result;
  if (data.store?.state !== "ready")
    await handshake($);
  await confirmReadback($, committed.key, committed.revision, readback);
}
async function confirmReadback($, key, revision, readback) {
  const view = await loadDetail($);
  if (view === null || !readbackConfirms(revision, key, view)) {
    data.notice = { tone: "info", text: "The save was recorded but a fresh read has not shown it yet. Refresh to check." };
    return;
  }
  const text = readback === "capture" ? "Saved locally. Not installed or queued for learning." : readback === "important" ? view.important ? "Marked important." : "No longer marked important." : readback === "acknowledge-source" ? "Current source accepted." : "Saved.";
  data.notice = { tone: "ok", text };
  await reloadList($);
}
async function verifyPurged($, own) {
  const target = data.controller.state.target;
  if (target === null)
    return;
  const expected = data.controller.state.expectedInstallation;
  data.detail = null;
  data.purgeCheck = "pending";
  const args = { key: encodeLessonKey(target.key), project: flatProject(target.scope.project), binding: flatBinding(recordReadBinding(target)) };
  const read = await lessonRead($, "lessons.get", args, (v) => decodeReadResult(v, (x) => x === null ? null : decodeLessonDetail(x)));
  if (!read.ok && read.stale)
    return;
  const detail = read.ok ? read.value : null;
  const verified = detail !== null && detail.value !== null && detail.value.lesson.sourceStatus === "purged" && sameKey2(detail.value.lesson.key, target.key) && (expected === null || detail.store.installationId === expected);
  data.purgeCheck = verified ? "verified" : "unavailable";
  if (verified && own)
    data.notice = { tone: "ok", text: "Purged locally. Its curated wording, quotes and history are gone from this installation." };
  if (verified)
    await reloadList($);
}
async function checkOutcome($) {
  const c = data.controller;
  const pending = c.state.pending;
  if (pending === null)
    return;
  if (!await handshake($) && data.block === null)
    return;
  const target = { scope: pending.scope, binding: pending.binding, key: pending.key };
  const epoch = data.epoch;
  const origin = installationOf2(pending);
  const binding = origin === null ? pending.binding : { kind: "installation", id: origin };
  const read = await lessonRead($, "lessons.receipt", { key: encodeLessonKey(pending.key), project: flatProject(pending.scope.project), binding: flatBinding(binding), requestId: pending.requestId }, (v) => decodeReadResult(v, (x) => decodeReceiptRead(x, pending.requestId)), () => c.state.pending?.requestId === pending.requestId);
  if (!read.ok) {
    if (!read.stale)
      data.notice = { tone: "error", text: `Could not check the earlier save: ${readMessage(read.error)} Its outcome is still unknown.` };
    return;
  }
  c.dispatch({ type: "receipt", generation: pending.generation, requestId: pending.requestId, target, receipt: read.value.value }, { operation: "receipt", connectionEpoch: epoch, generation: pending.generation, target, requestId: pending.requestId, installationId: read.value.store.installationId });
  const receipt = read.value.value;
  if (receipt.state === "unknown") {
    data.notice = { tone: "info", text: "No result recorded for this request yet. It may still be running." };
    return;
  }
  if (c.state.pending === null || data.block !== null)
    await handshake($);
  if (receipt.state === "committed" && c.state.pending === null)
    await confirmReadback($, receipt.key, receipt.revision, null);
  if (receipt.state === "purged")
    await verifyPurged($, false);
}
function sameKey2(a, b) {
  return a.world === b.world && a.kind === b.kind && a.id === b.id;
}
function sameProject(a, b) {
  return a.kind === b.kind && (a.kind !== "project" || a.id === b.id);
}
function readMessage(e) {
  switch (e.code) {
    case "TRANSPORT":
      return "The control bridge did not answer.";
    case "MALFORMED":
      return "The bridge sent an answer this console cannot read.";
    case "INSTALLATION_MISMATCH":
      return "Different SIL installation. Nothing from it is shown here.";
    case "STORE_CHANGED":
      return "The store changed while loading. Refresh to check its identity.";
    case "STORAGE_BUSY":
      return "Curation storage is busy. Try again.";
    case "STORAGE_UNAVAILABLE":
      return "Curation storage is unavailable.";
    case "UNSUPPORTED_SCHEMA":
      return "This installation's curation store has an unsupported version.";
    case "SCOPE_CONFLICT":
      return "This lesson belongs to another project.";
    default:
      return `Could not read lessons (${e.code}).`;
  }
}
function editorErrorText(code, fields = []) {
  switch (code) {
    case "INSTALLATION_MISMATCH":
      return "Different SIL installation. Nothing from it is shown or saved here.";
    case "STORE_UNRESOLVED":
      return "Cannot confirm which store holds this lesson, so nothing is shown.";
    case "CURATION_CONFLICT":
      return "This lesson changed elsewhere. Your wording is kept.";
    case "CAPTURE_EXISTS":
      return "A lesson with this id is already stored. Your wording is kept.";
    case "SCOPE_CONFLICT":
      return "This lesson belongs to another project.";
    case "SOURCE_CONFLICT":
      return "The delivery source disagrees with itself. Nothing was changed.";
    case "SENSITIVE_CONTENT":
      return `This looks like a secret${fields.length ? ` in ${fields.join(", ")}` : ""}. Remove it and save again.`;
    case "STORAGE_BUSY":
      return "Storage is busy. Nothing was saved. Try again.";
    case "STORAGE_UNAVAILABLE":
      return "Curation storage is unavailable.";
    case "UNSUPPORTED_SCHEMA":
      return "This installation's curation store has an unsupported version.";
    case "PURGED":
      return "This lesson was purged.";
    case "EDITOR_SATURATED":
      return "Too many unresolved saves in this session. Restart the session to continue.";
    case "INVALID_INPUT":
      return `Not saved: check ${fields.length ? fields.join(", ") : "the input"}.`;
    default:
      return `Request failed (${code}).`;
  }
}

// apps/hook-module/src/ui/pages.ts
var PROPOSAL_PAGE_MAX_BYTES = 65536;
var PROPOSAL_PAGE_MAX_LINES = 200;
var REVIEWED_STATE_RE = /^[0-9a-f]{64}$/;
function isPlainObject3(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function hasExactKeys(value, keys) {
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(value, k));
}
function isCount(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
var LIST_KEYS = ["world", "total", "offset", "limit", "items"];
function parseListPage(value, world) {
  if (!isPlainObject3(value) || !hasExactKeys(value, LIST_KEYS))
    return null;
  const { total, offset, limit, items } = value;
  if (value.world !== world || !isCount(total) || !isCount(offset) || !isCount(limit) || limit < 1)
    return null;
  if (!Array.isArray(items) || items.length > limit)
    return null;
  if (items.length !== Math.max(0, Math.min(limit, total - offset)))
    return null;
  return { world, total, offset, limit, items };
}
var PAGE_KEYS = [
  "world",
  "pattern",
  "part",
  "text",
  "offset",
  "lineCount",
  "nextOffset",
  "totalLines",
  "totalBytes",
  "reviewedState",
  "complete",
  "oversizedLine"
];
function parseProposalPage(value, scope) {
  if (!isPlainObject3(value) || !hasExactKeys(value, PAGE_KEYS))
    return null;
  const v = value;
  if (v.world !== scope.world || v.pattern !== scope.pattern || v.part !== scope.part || v.offset !== scope.offset)
    return null;
  if (typeof v.text !== "string" || typeof v.reviewedState !== "string" || !REVIEWED_STATE_RE.test(v.reviewedState))
    return null;
  if (typeof v.complete !== "boolean")
    return null;
  if (!isCount(v.lineCount) || !isCount(v.totalLines) || !isCount(v.totalBytes))
    return null;
  if (v.lineCount > PROPOSAL_PAGE_MAX_LINES || scope.offset + v.lineCount > v.totalLines)
    return null;
  if (utf8ByteLength(v.text) >= PROPOSAL_PAGE_MAX_BYTES)
    return null;
  const next = v.nextOffset;
  if (next !== null && (!isCount(next) || next <= scope.offset || next > v.totalLines))
    return null;
  let oversized = null;
  if (v.oversizedLine !== null) {
    const o = v.oversizedLine;
    if (!isPlainObject3(o) || !hasExactKeys(o, ["line", "bytes"]) || !isCount(o.line) || !isCount(o.bytes))
      return null;
    if (o.line !== scope.offset + 1 || v.text !== "" || v.lineCount !== 0 || v.complete)
      return null;
    oversized = { line: o.line, bytes: o.bytes };
  } else if (next !== null && next !== scope.offset + v.lineCount) {
    return null;
  }
  if (v.complete && (next !== null || scope.offset + v.lineCount !== v.totalLines))
    return null;
  return {
    world: scope.world,
    pattern: scope.pattern,
    part: scope.part,
    text: v.text,
    offset: scope.offset,
    lineCount: v.lineCount,
    nextOffset: next,
    totalLines: v.totalLines,
    totalBytes: v.totalBytes,
    reviewedState: v.reviewedState,
    complete: v.complete,
    oversizedLine: oversized
  };
}

// apps/hook-module/src/ui/state.ts
var CONSOLE_SECTIONS = ["overview", "review", "artifacts", "activity", "settings"];
var PROPOSAL_BACK_MAX = 200;
var BOOTSTRAP_READ = "bootstrap";
var WORKER_READ = "worker";
var LIST_READ = "list";
var PROPOSAL_READ = "proposal";
var REVIEW_READ = "review";
var LESSONS_READ = "lessons";
var GLOBAL_READS = [BOOTSTRAP_READ, WORKER_READ];
function initialConsoleState() {
  return {
    world: null,
    section: "overview",
    generation: 0,
    selectedPattern: null,
    loading: false,
    lastSuccessAt: null,
    results: {},
    error: null,
    listOffset: 0,
    proposal: null,
    lessonsOffset: 0,
    worldOffset: 0
  };
}
function switchConsoleWorld(state, world) {
  if (state.world === world)
    return state;
  return {
    ...state,
    world,
    generation: state.generation + 1,
    selectedPattern: null,
    loading: false,
    lastSuccessAt: null,
    results: {},
    error: null,
    listOffset: 0,
    proposal: null,
    lessonsOffset: 0
  };
}
function chooseConsoleWorld(state, world) {
  const next = switchConsoleWorld(state, world);
  if (next === state || !Object.hasOwn(state.results, BOOTSTRAP_READ))
    return next;
  return { ...next, results: { [BOOTSTRAP_READ]: state.results[BOOTSTRAP_READ] } };
}
function keepOnly(results, keep) {
  const out = {};
  for (const id of Object.keys(results))
    if (keep(id))
      out[id] = results[id];
  return out;
}
function rescope(state, change, keep) {
  return { ...state, ...change, generation: state.generation + 1, loading: false, results: keepOnly(state.results, keep) };
}
function selectConsoleSection(state, section) {
  if (state.section === section)
    return state;
  return rescope(state, { section, listOffset: 0, lessonsOffset: 0, selectedPattern: null, proposal: null }, (id) => GLOBAL_READS.includes(id));
}
function setLessonsOffset(state, offset) {
  if (!isCount(offset))
    throw new Error(`lessons offset ${offset} is not a whole number from 0`);
  if (state.lessonsOffset === offset)
    return state;
  return rescope(state, { lessonsOffset: offset }, (id) => id !== LESSONS_READ);
}
function setWorldOffset(state, offset) {
  if (!isCount(offset))
    throw new Error(`world offset ${offset} is not a whole number from 0`);
  if (state.worldOffset === offset)
    return state;
  return { ...state, worldOffset: offset };
}
function setConsoleListOffset(state, offset) {
  if (!isCount(offset))
    throw new Error(`list offset ${offset} is not a whole number from 0`);
  if (state.listOffset === offset)
    return state;
  return rescope(state, { listOffset: offset }, (id) => id !== LIST_READ);
}
function freshProposal(part = "body") {
  return { part, offset: 0, back: [], reviewedState: null };
}
function selectConsolePattern(state, pattern) {
  if (state.selectedPattern === pattern)
    return state;
  return rescope(state, { selectedPattern: pattern, proposal: pattern === null ? null : freshProposal() }, (id) => id !== PROPOSAL_READ);
}
function moveProposal(state, proposal) {
  return rescope(state, { proposal }, (id) => id !== PROPOSAL_READ);
}
function setProposalPart(state, part) {
  const p = state.proposal;
  if (p === null || p.part === part)
    return state;
  return moveProposal(state, { ...p, part, offset: 0, back: [] });
}
function currentProposalPage(state) {
  const p = state.proposal;
  if (p === null || state.world === null || state.selectedPattern === null)
    return null;
  if (!Object.hasOwn(state.results, PROPOSAL_READ))
    return null;
  const result = state.results[PROPOSAL_READ];
  if (!result.ok)
    return null;
  return parseProposalPage(result.value, { world: state.world, pattern: state.selectedPattern, part: p.part, offset: p.offset });
}
function turnProposalPage(state, to) {
  const p = state.proposal;
  if (p === null)
    return state;
  if (to === "first")
    return p.offset === 0 && p.back.length === 0 ? state : moveProposal(state, { ...p, offset: 0, back: [] });
  if (to === "prev") {
    const offset = p.back.at(-1);
    if (offset === undefined)
      return state;
    return moveProposal(state, { ...p, offset, back: p.back.slice(0, -1) });
  }
  const page = currentProposalPage(state);
  if (page === null || page.nextOffset === null || page.reviewedState !== p.reviewedState)
    return state;
  return moveProposal(state, { ...p, offset: page.nextOffset, back: [...p.back, p.offset].slice(-PROPOSAL_BACK_MAX) });
}
function reloadProposal(state) {
  const p = state.proposal;
  if (p === null)
    return state;
  return moveProposal(state, freshProposal(p.part));
}
function pinProposal(state) {
  if (state.proposal === null || state.proposal.reviewedState !== null)
    return state;
  const page = currentProposalPage(state);
  if (page === null)
    return state;
  return { ...state, proposal: { ...state.proposal, reviewedState: page.reviewedState } };
}
function beginConsoleRefresh(state, generation) {
  if (generation !== state.generation || state.loading)
    return state;
  return { ...state, loading: true };
}
function applyConsoleRead(state, generation, response, completedAt) {
  if (generation !== state.generation)
    return state;
  const results = { ...state.results };
  const ids = Object.keys(response.results);
  const failed = [];
  for (const id of ids) {
    const result = response.results[id];
    results[id] = result;
    if (!result.ok)
      failed.push(`${id}: ${result.error.code}`);
  }
  const complete = failed.length === 0;
  return pinProposal({
    ...state,
    loading: false,
    results,
    lastSuccessAt: complete ? completedAt : state.lastSuccessAt,
    error: complete ? null : `${failed.length} of ${ids.length} reads failed at ${completedAt} (${failed.join(", ")}).`
  });
}
function failConsoleRead(state, generation, message) {
  if (generation !== state.generation)
    return state;
  return { ...state, loading: false, error: `Refresh failed: ${message}` };
}
function invalidateConsole(state) {
  return { ...state, generation: state.generation + 1, loading: false };
}
function isStringArray(value) {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}
function isNullableString(value) {
  return value === null || typeof value === "string";
}
function parseBootstrap(value) {
  if (!isPlainObject3(value) || !hasExactKeys(value, ["worlds", "selectedWorld", "resolutionError", "initialized"]))
    return null;
  const { worlds, selectedWorld, resolutionError, initialized } = value;
  if (!isStringArray(worlds) || !isNullableString(selectedWorld) || !isNullableString(resolutionError))
    return null;
  if (typeof initialized !== "boolean")
    return null;
  if (selectedWorld !== null && !worlds.includes(selectedWorld))
    return null;
  return { worlds, selectedWorld, resolutionError, initialized };
}
function bootstrapOf(state) {
  if (!Object.hasOwn(state.results, BOOTSTRAP_READ))
    return null;
  const result = state.results[BOOTSTRAP_READ];
  if (!result.ok)
    return { ok: false, message: `${result.error.code}: ${result.error.message}` };
  const value = parseBootstrap(result.value);
  if (value === null)
    return { ok: false, message: "the world list came back malformed and was not used" };
  return { ok: true, value };
}
function reconcileConsoleWorld(state) {
  const boot = bootstrapOf(state);
  if (boot === null || !boot.ok)
    return state;
  const { worlds, selectedWorld } = boot.value;
  if (state.world !== null && worlds.includes(state.world))
    return state;
  if (selectedWorld !== null)
    return chooseConsoleWorld(state, selectedWorld);
  if (state.world === null)
    return state;
  return {
    ...state,
    world: null,
    generation: state.generation + 1,
    selectedPattern: null,
    loading: false,
    lastSuccessAt: null,
    results: { [BOOTSTRAP_READ]: state.results[BOOTSTRAP_READ] },
    error: `World ${JSON.stringify(state.world)} is no longer configured.`,
    listOffset: 0,
    proposal: null,
    lessonsOffset: 0
  };
}
var TASK4_KEYS = ["world", "section", "generation", "selectedPattern", "loading", "lastSuccessAt", "results", "error"];
var TASK5_KEYS = [...TASK4_KEYS, "listOffset", "proposal"];
var STATE_KEYS2 = [...TASK5_KEYS, "lessonsOffset", "worldOffset"];
function isControlResult(value) {
  if (!isPlainObject3(value))
    return false;
  if (value.ok === true)
    return hasExactKeys(value, ["ok", "value"]);
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"]))
    return false;
  const error = value.error;
  return isPlainObject3(error) && hasExactKeys(error, ["code", "message", "retryable"]) && typeof error.code === "string" && typeof error.message === "string" && typeof error.retryable === "boolean";
}
function isGeneration(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isProposalView(value) {
  if (!isPlainObject3(value) || !hasExactKeys(value, ["part", "offset", "back", "reviewedState"]))
    return false;
  if (value.part !== "body" && value.part !== "diff")
    return false;
  if (!isCount(value.offset) || !Array.isArray(value.back) || value.back.length > PROPOSAL_BACK_MAX)
    return false;
  if (!value.back.every(isCount))
    return false;
  return value.reviewedState === null || typeof value.reviewedState === "string" && REVIEWED_STATE_RE.test(value.reviewedState);
}
function isTask4Fields(v) {
  if (!isNullableString(v.world) || !isNullableString(v.selectedPattern))
    return false;
  if (!isNullableString(v.lastSuccessAt) || !isNullableString(v.error))
    return false;
  if (typeof v.section !== "string" || !CONSOLE_SECTIONS.includes(v.section))
    return false;
  if (!isGeneration(v.generation) || typeof v.loading !== "boolean")
    return false;
  if (!isPlainObject3(v.results))
    return false;
  return Object.values(v.results).every(isControlResult);
}
function isTask5Fields(value) {
  if (!isTask4Fields(value) || !isCount(value.listOffset))
    return false;
  if (value.proposal !== null && !isProposalView(value.proposal))
    return false;
  return value.selectedPattern === null === (value.proposal === null);
}
function isConsoleState(value) {
  if (!isPlainObject3(value) || !hasExactKeys(value, STATE_KEYS2) || !isTask5Fields(value))
    return false;
  return isCount(value.lessonsOffset) && isCount(value.worldOffset);
}
function parseConsoleState(value) {
  if (value === undefined)
    return { state: initialConsoleState(), reset: "none" };
  if (isPlainObject3(value) && hasExactKeys(value, ["opens"]) && typeof value.opens === "number") {
    return { state: initialConsoleState(), reset: "legacy" };
  }
  if (isPlainObject3(value) && hasExactKeys(value, TASK4_KEYS) && isTask4Fields(value)) {
    const old = value;
    return {
      state: {
        ...old,
        generation: old.generation + 1,
        loading: false,
        results: keepOnly(old.results, (id) => GLOBAL_READS.includes(id)),
        listOffset: 0,
        proposal: old.selectedPattern === null ? null : freshProposal(),
        lessonsOffset: 0,
        worldOffset: 0
      },
      reset: "migrated"
    };
  }
  if (isPlainObject3(value) && hasExactKeys(value, TASK5_KEYS) && isTask5Fields(value)) {
    const old = value;
    const proposal = old.proposal === null ? null : { ...old.proposal, back: [...old.proposal.back] };
    return {
      state: {
        ...old,
        generation: old.generation + 1,
        loading: false,
        results: keepOnly(old.results, (id) => id !== REVIEW_READ),
        proposal,
        lessonsOffset: 0,
        worldOffset: 0
      },
      reset: "migrated"
    };
  }
  if (isConsoleState(value)) {
    const proposal = value.proposal === null ? null : { ...value.proposal, back: [...value.proposal.back] };
    return { state: { ...value, results: { ...value.results }, proposal }, reset: "none" };
  }
  const held = isPlainObject3(value) && isGeneration(value.generation) ? value.generation : 0;
  return {
    state: {
      ...initialConsoleState(),
      generation: held + 1,
      error: "The console's saved view state was unreadable and was reset."
    },
    reset: "corrupt"
  };
}

// apps/hook-module/src/ui/views.ts
var CONSOLE_REFRESH_MS = 1e4;
var NARROW_COLUMNS = 44;
var LIST_PAGE_SIZE = 10;
var LOG_LINES = 20;
var LESSONS_SHOWN = 5;
var QUEUE_SHOWN = 5;
var QUEUE_LIST_CAP = 200;
var ROW_CHARS = 300;
var LINE_CHARS = 2000;
var WORLD_WINDOW = 25;
var DISPLAY_BUDGET = 90000;
var QUEUE_READ = "queue";
var LOGS_READ = "logs";
function sectionList(section) {
  if (section === "review")
    return "review";
  if (section === "artifacts")
    return "artifacts";
  if (section === "activity")
    return "reflections";
  return null;
}
function consoleReads(state, cwd) {
  const reads = [
    { id: BOOTSTRAP_READ, op: "console.bootstrap", args: { cwd } },
    { id: WORKER_READ, op: "worker.status", args: {} }
  ];
  const world = state.world;
  if (state.section === "activity") {
    reads.push({ id: QUEUE_READ, op: "queue.list", args: {} });
    reads.push({ id: LOGS_READ, op: "logs.tail", args: { name: "worker", lines: LOG_LINES } });
  }
  if (world === null)
    return reads;
  if (state.section === "overview")
    reads.push({ id: REVIEW_READ, op: "console.page", args: { world, kind: "review", offset: 0, limit: 1 } });
  const kind = sectionList(state.section);
  if (kind !== null)
    reads.push({ id: LIST_READ, op: "console.page", args: { world, kind, offset: state.listOffset, limit: LIST_PAGE_SIZE } });
  if (state.section === "activity") {
    reads.push({ id: LESSONS_READ, op: "console.page", args: { world, kind: "lessons", offset: state.lessonsOffset, limit: LESSONS_SHOWN } });
  }
  if (state.section === "review" && state.selectedPattern !== null && state.proposal !== null) {
    const p = state.proposal;
    const args = { world, pattern: state.selectedPattern, part: p.part, offset: p.offset, limit: PROPOSAL_PAGE_MAX_LINES };
    if (p.reviewedState !== null)
      args.expectedState = p.reviewedState;
    reads.push({ id: PROPOSAL_READ, op: "console.proposalPage", args });
  }
  return reads;
}
function printable(text) {
  let replaced = 0;
  const out = text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (c) => {
    replaced += 1;
    const code = c.charCodeAt(0);
    if (code < 32)
      return String.fromCharCode(9216 + code);
    if (code === 127)
      return "␡";
    return "�";
  });
  return { text: out, replaced };
}
function row(text, max = ROW_CHARS) {
  return text.length > max ? `${text.slice(0, max)}... (shortened)` : text;
}
function boundedErrorText(message) {
  return printable(row(message)).text;
}
var SECTION_LABELS = {
  overview: "Overview",
  review: "Review",
  artifacts: "Artifacts",
  activity: "Activity",
  settings: "Settings"
};
function sectionLabel(section) {
  return SECTION_LABELS[section];
}
function isRecord8(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str4(value) {
  return typeof value === "string" ? value : null;
}
function workerLine(state) {
  if (!Object.hasOwn(state.results, WORKER_READ))
    return null;
  const result = state.results[WORKER_READ];
  if (!result.ok)
    return { text: `Worker status (global) unavailable: ${result.error.code}: ${result.error.message}`, tone: "error" };
  const v = result.value;
  if (!isRecord8(v) || !isCount(v.pending) || !isCount(v.done) || !isCount(v.failed)) {
    return { text: "Worker status came back in an unexpected shape and is not shown.", tone: "error" };
  }
  const running = v.lock_held === true ? "running" : "idle";
  const lastRun = typeof v.last_run === "string" ? `last run ${v.last_run}` : "no run recorded";
  return {
    text: `Worker (global, all worlds): ${running}, ${lastRun}. Pending: ${v.pending}, done: ${v.done}, failed: ${v.failed}.`,
    tone: "plain"
  };
}
function reviewLine(state) {
  if (state.world === null)
    return null;
  if (!Object.hasOwn(state.results, REVIEW_READ))
    return { text: "Review queue: not read yet.", tone: "dim" };
  const result = state.results[REVIEW_READ];
  if (!result.ok)
    return { text: `Review queue unavailable: ${result.error.code}: ${result.error.message}`, tone: "error" };
  const page = parseListPage(result.value, state.world);
  if (page === null)
    return { text: "Review queue came back in an unexpected shape and is not shown.", tone: "error" };
  const n = page.total;
  return { text: `${n} staged ${n === 1 ? "proposal" : "proposals"} waiting for review in ${state.world}.`, tone: "plain" };
}
function consoleLines(state) {
  const lines = [];
  lines.push({ text: state.world === null ? "World: none selected." : `World: ${state.world}`, tone: "title" });
  lines.push({ text: `Section: ${sectionLabel(state.section)}`, tone: "dim" });
  if (state.loading)
    lines.push({ text: "Refreshing...", tone: "dim" });
  if (state.error !== null) {
    lines.push({ text: state.error, tone: "error" });
    const shown = Object.values(state.results).some((r) => r.ok);
    if (shown) {
      const since = state.lastSuccessAt === null ? "no refresh has fully worked yet" : `last complete refresh ${state.lastSuccessAt}`;
      lines.push({ text: `Values below may be stale (${since}).`, tone: "error" });
    }
  } else if (state.lastSuccessAt !== null) {
    lines.push({ text: `Last complete refresh: ${state.lastSuccessAt}`, tone: "dim" });
  } else if (!state.loading) {
    lines.push({ text: "Not read yet.", tone: "dim" });
  }
  const boot = bootstrapOf(state);
  if (boot !== null && !boot.ok)
    lines.push({ text: `World list unavailable: ${boot.message}`, tone: "error" });
  if (boot !== null && boot.ok) {
    const { initialized, resolutionError } = boot.value;
    if (!initialized)
      lines.push({ text: resolutionError ?? "The loop is not set up yet.", tone: "error" });
    else if (resolutionError !== null && state.world === null) {
      lines.push({ text: `No world chosen for this directory: ${resolutionError}. Pick one below.`, tone: "error" });
    }
  }
  if (state.section === "overview") {
    const worker = workerLine(state);
    if (worker)
      lines.push(worker);
    const review = reviewLine(state);
    if (review)
      lines.push(review);
  }
  return lines;
}
var SAFE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
function worldKey(world) {
  if (SAFE_KEY.test(world) && !world.startsWith("encoded-"))
    return `world-${world}`;
  const encoded = Array.from({ length: world.length }, (_, index) => world.charCodeAt(index).toString(16).padStart(4, "0")).join("");
  return `world-encoded-${encoded}`;
}
function consoleControls(state) {
  const sections = CONSOLE_SECTIONS.map((section) => ({
    key: `section-${section}`,
    label: sectionLabel(section),
    action: { kind: "section", section },
    isCurrent: state.section === section
  }));
  const boot = bootstrapOf(state);
  const worlds = boot !== null && boot.ok ? boot.value.worlds.map((world) => ({
    key: worldKey(world),
    label: world,
    action: { kind: "world", world },
    isCurrent: state.world === world
  })) : [];
  return { sections, worlds, refresh: { key: "refresh", label: "Refresh", action: { kind: "refresh" }, isCurrent: false } };
}
function selectAction(state, key, value) {
  if (key === "section-select") {
    const section = CONSOLE_SECTIONS.find((s) => s === value);
    return section === undefined ? null : { kind: "section", section };
  }
  if (key === "world-select") {
    const boot = bootstrapOf(state);
    return boot !== null && boot.ok && boot.value.worlds.includes(value) ? { kind: "world", world: value } : null;
  }
  return null;
}
function line(text, tone = "plain") {
  return { kind: "line", line: { text, tone } };
}
function controls(key, list, direction = "row", label) {
  return label === undefined ? { kind: "controls", key, direction, controls: list } : { kind: "controls", key, direction, controls: list, label };
}
function control(key, label, action, isCurrent = false) {
  return { key, label, action, isCurrent };
}
function navigation(state, layout) {
  const narrow = layout.columns < NARROW_COLUMNS;
  const c = consoleControls(state);
  const blocks = [];
  if (narrow && layout.canSelect) {
    blocks.push({
      kind: "select",
      key: "section-select",
      label: "Section",
      value: state.section,
      options: CONSOLE_SECTIONS.map((s) => ({ value: s, label: sectionLabel(s) }))
    });
  } else {
    blocks.push(controls("sections", c.sections, narrow ? "column" : "row"));
  }
  if (c.worlds.length > 0) {
    const all = c.worlds;
    const last = Math.max(0, Math.floor((all.length - 1) / WORLD_WINDOW) * WORLD_WINDOW);
    const from = Math.min(state.worldOffset - state.worldOffset % WORLD_WINDOW, last);
    const window = all.slice(from, from + WORLD_WINDOW);
    const current = all.find((w) => w.isCurrent);
    if (current !== undefined && !window.includes(current))
      window.push(current);
    const label = all.length > WORLD_WINDOW ? `Worlds ${from + 1}-${Math.min(from + WORLD_WINDOW, all.length)} of ${all.length}:` : "Worlds:";
    if (narrow && layout.canSelect) {
      const options = window.map((w) => ({ value: w.action.kind === "world" ? w.action.world : w.label, label: w.label }));
      blocks.push({ kind: "select", key: "world-select", label: all.length > WORLD_WINDOW ? label.slice(0, -1) : "World", value: state.world, options });
    } else {
      blocks.push(controls("worlds", window, narrow ? "column" : "row", label));
    }
    const paging = [];
    if (from > 0)
      paging.push(control("worlds-prev", "Previous worlds", { kind: "worlds", offset: Math.max(0, from - WORLD_WINDOW) }));
    if (from + WORLD_WINDOW < all.length)
      paging.push(control("worlds-next", "More worlds", { kind: "worlds", offset: from + WORLD_WINDOW }));
    if (paging.length > 0)
      blocks.push(controls("worlds-paging", paging));
  }
  blocks.push(controls("actions", [c.refresh, control("close", "Close", { kind: "close" })]));
  return blocks;
}
function resultOf(state, id) {
  if (!Object.hasOwn(state.results, id))
    return { kind: "absent" };
  const r = state.results[id];
  return r.ok ? { kind: "ok", value: r.value } : { kind: "error", code: r.error.code, message: r.error.message };
}
var LIST_NOUNS = {
  review: ["Proposals", "staged proposals"],
  artifacts: ["Artifacts", "artifacts"],
  reflections: ["Reflections", "reflections"],
  lessons: ["Lessons", "lessons in the inbox"]
};
var LIST_PAGING = { prefix: "list", to: (offset) => ({ kind: "list", offset }) };
var LESSONS_PAGING = { prefix: "lessons", to: (offset) => ({ kind: "lessons", offset }) };
function listBlocks(state, id, kind, rows, paging) {
  const [title, plural] = LIST_NOUNS[kind];
  const world = state.world;
  const r = resultOf(state, id);
  if (r.kind === "absent")
    return [line(state.loading ? `${title}: reading...` : `${title}: not read yet.`, "dim")];
  if (r.kind === "error")
    return [line(`${title} unavailable: ${r.code}: ${r.message}`, "error")];
  const page = parseListPage(r.value, world);
  if (page === null)
    return [line(`${title} came back in an unexpected shape and are not shown.`, "error")];
  if (page.total === 0)
    return [line(`No ${plural} in ${world}.`, "dim")];
  const blocks = [];
  if (page.items.length === 0) {
    blocks.push(line(`No ${title.toLowerCase()} on this page: the list has ${page.total}.`, "dim"));
    blocks.push(controls(`${paging.prefix}-paging`, [control(`${paging.prefix}-first`, "First page", paging.to(0))]));
    return blocks;
  }
  const last = page.offset + page.items.length;
  blocks.push(line(`${title} ${page.offset + 1}-${last} of ${page.total} in ${world}:`, "title"));
  blocks.push(...rows(page));
  const turns = [];
  if (page.offset > 0)
    turns.push(control(`${paging.prefix}-prev`, "Previous", paging.to(Math.max(0, page.offset - page.limit))));
  if (last < page.total)
    turns.push(control(`${paging.prefix}-next`, "Next", paging.to(last)));
  if (turns.length > 0)
    blocks.push(controls(`${paging.prefix}-paging`, turns));
  return blocks;
}
var SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
function reviewRows(state, page) {
  const items = [];
  const odd = [];
  for (const item of page.items) {
    const pattern = isRecord8(item) ? str4(item.pattern) : null;
    if (pattern === null || !SLUG.test(pattern)) {
      odd.push(line("A proposal came back in an unexpected shape and is not shown.", "error"));
      continue;
    }
    const type = isRecord8(item) ? str4(item.artifact_type) ?? "?" : "?";
    const status = isRecord8(item) ? str4(item.status) ?? "?" : "?";
    items.push(control(`proposal-${pattern}`, `${pattern} (${row(type)}, ${row(status)})`, { kind: "select", pattern }, state.selectedPattern === pattern));
  }
  return [controls("proposals", items, "column"), ...odd];
}
function artifactRows(page) {
  return page.items.map((item) => {
    if (!isRecord8(item) || str4(item.pattern) === null)
      return line("An artifact came back in an unexpected shape and is not shown.", "error");
    const served = str4(item.served_by);
    const reflections = isCount(item.reflections) ? `${item.reflections} reflections` : "reflections unknown";
    return line(row(`${item.pattern}: ${str4(item.artifact_type) ?? "?"}, ${str4(item.status) ?? "?"}, ${reflections}${served ? `, served by ${served}` : ""}`));
  });
}
function reflectionRows(page) {
  return page.items.map((item) => {
    if (!isRecord8(item) || str4(item.pattern) === null)
      return line("A reflection came back in an unexpected shape and is not shown.", "error");
    return line(row(`${str4(item.created) ?? "?"} ${item.pattern}: ${str4(item.lesson) ?? "(no lesson)"}`));
  });
}
function lessonRows(page) {
  return page.items.map((item) => {
    if (!isRecord8(item) || str4(item.pattern) === null)
      return line("A lesson came back in an unexpected shape and is not shown.", "error");
    return line(row(`${item.pattern}: ${str4(item.text) ?? "?"}`));
  });
}
function isWholeHunks(text) {
  const lines = text.split(`
`);
  if (lines.at(-1) === "")
    lines.pop();
  let i = 0;
  let hunks = 0;
  while (i < lines.length) {
    const head = lines[i];
    if (head.startsWith("--- ") && lines[i + 1]?.startsWith("+++ ")) {
      i += 2;
      continue;
    }
    const m = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(head);
    if (m === null)
      return false;
    let old = m[1] === undefined ? 1 : Number(m[1]);
    let neu = m[2] === undefined ? 1 : Number(m[2]);
    i += 1;
    while (old > 0 || neu > 0) {
      const l = lines[i];
      if (l === undefined)
        return false;
      if (l.startsWith("\\")) {
        i += 1;
        continue;
      }
      const mark = l === "" ? " " : l[0];
      if (mark === " ") {
        old -= 1;
        neu -= 1;
      } else if (mark === "-")
        old -= 1;
      else if (mark === "+")
        neu -= 1;
      else
        return false;
      if (old < 0 || neu < 0)
        return false;
      i += 1;
    }
    while (lines[i]?.startsWith("\\"))
      i += 1;
    hunks += 1;
  }
  return hunks > 0;
}
var PART_NAMES = { body: "body", diff: "diff" };
function proposalBlocks(state, narrow) {
  const p = state.proposal;
  const pattern = state.selectedPattern;
  const part = PART_NAMES[p.part];
  const blocks = [line(`Proposal: ${pattern}`, "title")];
  blocks.push(controls("proposal-nav", [
    control("proposal-back", narrow ? "Back to the list" : "Close proposal", { kind: "select", pattern: null }),
    control("part-body", "Body", { kind: "part", part: "body" }, p.part === "body"),
    control("part-diff", "Diff", { kind: "part", part: "diff" }, p.part === "diff")
  ]));
  blocks.push(line(p.reviewedState === null ? "Reviewed state: not read yet." : `Reviewed state: ${p.reviewedState}`, "dim"));
  const changed = () => [
    line("The proposal changed while you were reading it. Pages of two revisions are never joined: read it again from the start.", "error"),
    controls("proposal-reload", [control("proposal-reload", "Read again from the start", { kind: "reload-proposal" })])
  ];
  const r = resultOf(state, PROPOSAL_READ);
  if (r.kind === "absent") {
    blocks.push(line(`Reading the ${part}...`, "dim"));
    return blocks;
  }
  if (r.kind === "error") {
    if (r.code === "ProposalChanged")
      return [...blocks, ...changed()];
    blocks.push(line(`The ${part} is unavailable: ${r.code}: ${r.message}`, "error"));
    return blocks;
  }
  const page = currentProposalPage(state);
  if (page === null) {
    blocks.push(line(`This page of the ${part} came back in an unexpected shape and is not shown.`, "error"));
    return blocks;
  }
  if (p.reviewedState !== null && page.reviewedState !== p.reviewedState)
    return [...blocks, ...changed()];
  if (page.oversizedLine !== null) {
    blocks.push(line(`Line ${page.oversizedLine.line} of ${page.totalLines} is ${page.oversizedLine.bytes} bytes, more than one page holds (${PROPOSAL_PAGE_MAX_BYTES}). ` + `It is left out here, not cut: read the full ${part} with the CLI or \`sil web\`.`, "error"));
  } else if (page.totalLines === 0) {
    blocks.push(line(`The ${part} is empty.`, "dim"));
  } else {
    blocks.push(line(`${p.part === "body" ? "Body" : "Diff"} lines ${page.offset + 1}-${page.offset + page.lineCount} of ${page.totalLines}.`, "dim"));
    blocks.push({ kind: "code", source: page.text, diff: p.part === "diff" && isWholeHunks(page.text) });
  }
  const status = (text) => ({ kind: "line", line: { text, tone: "dim" }, pageStatus: true });
  if (page.complete)
    blocks.push(status(`End of the ${part}.`));
  else if (page.nextOffset !== null)
    blocks.push(status(`More of the ${part} follows: this page is not the whole ${part}.`));
  else
    blocks.push(status(`That was the last line of the ${part}, left out above. There is no next page, and the ${part} was not shown whole.`));
  const paging = [];
  if (page.offset > 0 || p.back.length > 0)
    paging.push(control("page-first", "First page", { kind: "page", to: "first" }));
  if (p.back.length > 0)
    paging.push(control("page-prev", "Previous page", { kind: "page", to: "prev" }));
  if (page.nextOffset !== null)
    paging.push(control("page-next", "Next page", { kind: "page", to: "next" }));
  if (paging.length > 0)
    blocks.push(controls("proposal-paging", paging));
  return blocks;
}
var READ_ONLY_NOTE = "Read only: accepting, rejecting and revising proposals are not available in this console yet. Use `sil web` or the CLI.";
function reviewSection(state, narrow) {
  if (state.world === null)
    return [line("Choose a world to see its staged proposals.", "dim")];
  const blocks = [line(READ_ONLY_NOTE, "dim")];
  const open = state.selectedPattern !== null && state.proposal !== null;
  if (!(narrow && open))
    blocks.push(...listBlocks(state, LIST_READ, "review", (page) => reviewRows(state, page), LIST_PAGING));
  if (open)
    blocks.push(...proposalBlocks(state, narrow));
  return blocks;
}
function artifactsSection(state) {
  if (state.world === null)
    return [line("Choose a world to see its artifacts.", "dim")];
  return listBlocks(state, LIST_READ, "artifacts", artifactRows, LIST_PAGING);
}
function queueBlocks(state) {
  const r = resultOf(state, QUEUE_READ);
  if (r.kind === "absent")
    return [line("Queue (global, all worlds): not read yet.", "dim")];
  if (r.kind === "error")
    return [line(`Queue (global, all worlds) unavailable: ${r.code}: ${r.message}`, "error")];
  const v = r.value;
  if (!isRecord8(v) || !Array.isArray(v.pending) || !Array.isArray(v.done) || !Array.isArray(v.failed)) {
    return [line("Queue came back in an unexpected shape and is not shown.", "error")];
  }
  const entry = (bucket, e) => {
    if (!isRecord8(e) || str4(e.session_id) === null)
      return line("A queue entry came back in an unexpected shape and is not drawn.", "error");
    const result = str4(e.result);
    return line(row(`${bucket}: ${e.session_id} (${str4(e.world) ?? "?"}) last stop ${str4(e.last_stop) ?? "?"}${result ? `: ${result}` : ""}`));
  };
  const drawn = (name, list) => list.length === 0 ? `${name}: 0 returned.` : `${name}: ${Math.min(QUEUE_SHOWN, list.length)} newest drawn of ${list.length} returned.`;
  const blocks = [line("Queue (global, all worlds), newest first:", "title")];
  blocks.push(line(drawn("Pending", v.pending)));
  for (const e of v.pending.slice(0, QUEUE_SHOWN))
    blocks.push(entry("pending", e));
  blocks.push(line(drawn("Failed", v.failed)));
  for (const e of v.failed.slice(0, QUEUE_SHOWN))
    blocks.push(entry("failed", e));
  blocks.push(line(v.done.length === 0 ? "Done: 0 returned." : `Done: ${v.done.length} returned, none drawn here.`));
  if ([v.pending, v.done, v.failed].some((list) => list.length >= QUEUE_LIST_CAP)) {
    blocks.push(line(`The bridge returns at most ${QUEUE_LIST_CAP} entries per list, so full counts may be higher; the worker line has the totals.`, "dim"));
  }
  const hidden = isRecord8(v.hidden) ? v.hidden : {};
  for (const bucket of ["done", "failed"]) {
    const n = hidden[bucket];
    if (isCount(n) && n > 0)
      blocks.push(line(`${n} ${bucket} entries are hidden by a clear.`, "dim"));
  }
  return blocks;
}
function logBlocks(state) {
  const r = resultOf(state, LOGS_READ);
  if (r.kind === "absent")
    return [line("Worker log (global): not read yet.", "dim")];
  if (r.kind === "error")
    return [line(`Worker log (global) unavailable: ${r.code}: ${r.message}`, "error")];
  const v = r.value;
  if (!isRecord8(v) || typeof v.exists !== "boolean" || !Array.isArray(v.lines) || !v.lines.every((l) => typeof l === "string")) {
    return [line("Worker log came back in an unexpected shape and is not shown.", "error")];
  }
  if (!v.exists)
    return [line("Worker log (global): no log written yet.", "dim")];
  const lines = v.lines.slice(-LOG_LINES);
  const blocks = [line(`Worker log (global, all worlds), last ${lines.length} lines:`, "title")];
  for (const l of lines)
    blocks.push(line(row(l)));
  return blocks;
}
function activitySection(state) {
  const blocks = [];
  const worker = workerLine(state);
  if (worker)
    blocks.push({ kind: "line", line: worker });
  blocks.push(...queueBlocks(state));
  if (state.world === null)
    blocks.push(line("Choose a world to see its reflections and lessons.", "dim"));
  else {
    blocks.push(...listBlocks(state, LIST_READ, "reflections", reflectionRows, LIST_PAGING));
    blocks.push(...listBlocks(state, LESSONS_READ, "lessons", lessonRows, LESSONS_PAGING));
  }
  blocks.push(...logBlocks(state));
  return blocks;
}
function settingsSection() {
  return [
    line("Settings (read only).", "title"),
    line("This console does not change settings yet: loop, promotion, model, world and schedule settings stay as they are.", "plain"),
    line("To change them, use the CLI (`sil worlds`, `sil llm`, `sil schedule`) or `sil web`.", "dim")
  ];
}
function consoleView(state, layout) {
  const narrow = layout.columns < NARROW_COLUMNS;
  const blocks = [line("Self-improvement loop", "title"), ...navigation(state, layout)];
  for (const l of consoleLines(state))
    blocks.push({ kind: "line", line: l });
  if (state.section === "review")
    blocks.push(...reviewSection(state, narrow));
  else if (state.section === "artifacts")
    blocks.push(...artifactsSection(state));
  else if (state.section === "activity")
    blocks.push(...activitySection(state));
  else if (state.section === "settings")
    blocks.push(...settingsSection());
  return finishView(blocks);
}
function blockChars(block) {
  switch (block.kind) {
    case "line":
      return block.line.text.length;
    case "code":
      return block.source.length;
    case "select":
      return block.label.length + block.options.reduce((n, o) => n + o.value.length + o.label.length, 0);
    case "controls":
      return (block.label?.length ?? 0) + block.controls.reduce((n, c) => n + c.label.length + (c.isCurrent ? CURRENT_MARK.length : 0), 0);
  }
}
var CURRENT_MARK = " (current)";
function sum(blocks) {
  return blocks.reduce((n, b) => n + blockChars(b), 0);
}
function enforceDisplayBudget(blocks, budget) {
  if (sum(blocks) <= budget)
    return blocks;
  let out = blocks;
  if (out.some((b) => b.kind === "code")) {
    out = out.flatMap((b) => {
      if (b.kind === "code") {
        return [line(`This page is too large to show with the rest of the pane (${b.source.length} characters); it is left out, not cut. Read it with the CLI or \`sil web\`.`, "error")];
      }
      return b.kind === "line" && b.pageStatus ? [] : [b];
    });
    if (sum(out) <= budget)
      return out;
  }
  const notice = (n) => line(`${n} more items are not shown: the pane's display budget is full.`, "error");
  const reserve = blockChars(notice(out.length));
  const kept = [];
  let used = 0;
  for (const b of out) {
    const size = blockChars(b);
    if (used + size + reserve > budget)
      break;
    kept.push(b);
    used += size;
  }
  return [...kept, notice(out.length - kept.length)];
}
function finishView(blocks) {
  let replaced = 0;
  const safe = (text) => {
    const p = printable(text);
    replaced += p.replaced;
    return p.text;
  };
  const out = blocks.map((b) => {
    switch (b.kind) {
      case "line":
        return { ...b, line: { ...b.line, text: row(safe(b.line.text), LINE_CHARS) } };
      case "code":
        return { ...b, source: safe(b.source) };
      case "select":
        return { ...b, label: safe(b.label), options: b.options.map((o) => ({ value: o.value, label: row(safe(o.label), ROW_CHARS) })) };
      case "controls": {
        const controls = b.controls.map((c) => ({ ...c, label: row(safe(c.label), ROW_CHARS) }));
        return b.label === undefined ? { ...b, controls } : { ...b, label: safe(b.label), controls };
      }
    }
  });
  if (replaced > 0)
    out.push(line(`${replaced} control characters are shown as symbols.`, "dim"));
  return enforceDisplayBudget(out, DISPLAY_BUDGET);
}

// apps/hook-module/src/ui/lessons-view.tsx
var FILTER_LABELS = { saved: "Saved", inbox: "Delivery inbox", archived: "Archived", important: "Important" };
var ROW_CHARS2 = 200;
var TEXT_CHARS = 4000;
var SLUG2 = /^[a-z0-9][a-z0-9-]{0,63}$/;
var PROJECT_WINDOW = 24;
function dropNote(name) {
  return `The ${name} you typed was over ${MAX_FIELD_CHARS} characters and was not kept. This field shows the earlier text; edit it before saving.`;
}
function shown(text, max = ROW_CHARS2) {
  const p = printable(text).text;
  return p.length > max ? `${p.slice(0, max)}... (shortened)` : p;
}
function paneView(props) {
  if (typeof props !== "object" || props === null)
    return null;
  const view = props.view;
  if (typeof view !== "object" || view === null || Array.isArray(view))
    return null;
  const agentId = view.agentId;
  if (agentId === undefined)
    return {};
  return typeof agentId === "string" ? { agentId } : null;
}
async function drawLessons($, ui, e, world, columns) {
  const { Box, Text, Button } = ui;
  const Input = e.surface !== "mobile" && "Input" in ui ? ui.Input : undefined;
  const Select = e.surface !== "mobile" && "Select" in ui ? ui.Select : undefined;
  await $.state.get({ plugin: "self-improvement-loop", key: "lessons" });
  const vm = lessonsViewModel();
  const narrow = columns < NARROW_COLUMNS;
  const direction = narrow ? "column" : "row";
  const view = paneView(e.props);
  const act = (action) => () => {
    lessonsAct($, action, world).then((done) => {
      if (done.switchWorld !== null)
        consoleAct($, { kind: "world", world: done.switchWorld });
    });
  };
  const button = (key, label, action) => /* @__PURE__ */ h(Button, {
    key,
    label,
    onPress: act(action)
  });
  const line = (text, tone = "plain", max = ROW_CHARS2) => {
    const t = shown(text, max);
    if (tone === "error")
      return /* @__PURE__ */ h(Text, {
        color: "error"
      }, `Error: ${t}`);
    if (tone === "dim")
      return /* @__PURE__ */ h(Text, {
        dimColor: true
      }, t);
    if (tone === "title")
      return /* @__PURE__ */ h(Text, {
        bold: true
      }, t);
    return /* @__PURE__ */ h(Text, null, t);
  };
  const row = (children) => /* @__PURE__ */ h(Box, {
    flexDirection: direction,
    gap: 1
  }, children);
  if (!vm.open) {
    return /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, line("Curated lessons: capture, edit wording and mark important.", "dim"), row([button("lessons-open", "Open lessons", { kind: "open" }), button("lesson-capture", "Capture selection", { kind: "capture", view })]));
  }
  const out = [line("Curated lessons", "title")];
  out.push(row([button("lessons-close", "Close lessons", { kind: "close" }), button("lessons-refresh", "Refresh lessons", { kind: "refresh" })]));
  if (vm.restoreNote !== null)
    out.push(line(vm.restoreNote, "error"));
  if (vm.persistWarning !== null)
    out.push(line(vm.persistWarning, "error"));
  if (world === null) {
    out.push(line("Choose a world to see its curated lessons.", "dim"));
    return /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, out);
  }
  if (vm.world !== null && vm.world !== world)
    out.push(line(`These lessons are from world ${vm.world}. Refresh lessons to follow the console to ${world}.`, "error"));
  if (vm.handshakeError !== null)
    out.push(line(vm.handshakeError, "error"));
  if (vm.block !== null)
    out.push(line(vm.block, "error"));
  if (vm.notice !== null)
    out.push(line(vm.notice.text, vm.notice.tone === "error" ? "error" : vm.notice.tone === "ok" ? "plain" : "dim"));
  if (vm.reading)
    out.push(line("Reading lessons...", "dim"));
  if (vm.prompt !== null || vm.editor.blocked !== null) {
    out.push(line("This lesson has unsent wording. Stay to keep editing, or Discard it and continue.", "error"));
    out.push(row([button("lesson-stay", "Stay", { kind: "stay" }), button("lesson-discard", "Discard", { kind: "discard" })]));
  }
  const value = vm.project === null ? undefined : flatProject(vm.project);
  const currentChoice = vm.project === null ? undefined : vm.choices.find((c) => flatProject(c.scope.project) === value);
  if (vm.sending && vm.choices.length > 0) {
    out.push(line(`Project: ${currentChoice?.label ?? "none chosen"} (held while the save runs).`, "dim"));
  } else if (vm.choices.length > 0) {
    const all = vm.choices.map((c) => ({ value: flatProject(c.scope.project), label: shown(`${c.label}${c.available ? "" : " (unavailable here)"}`) }));
    const last = Math.max(0, Math.floor((all.length - 1) / PROJECT_WINDOW) * PROJECT_WINDOW);
    const from = Math.min(vm.projectOffset - vm.projectOffset % PROJECT_WINDOW, last);
    const options = all.slice(from, from + PROJECT_WINDOW);
    const current = all.find((o) => o.value === value);
    if (current !== undefined && !options.includes(current))
      options.push(current);
    if (all.length > PROJECT_WINDOW)
      out.push(line(`Projects ${from + 1}-${Math.min(from + PROJECT_WINDOW, all.length)} of ${all.length}.`, "dim"));
    if (Select !== undefined) {
      out.push(value === undefined ? /* @__PURE__ */ h(Select, {
        key: "lessons-project",
        label: "Project",
        options,
        onSelect: (v) => act({ kind: "project", project: v })()
      }) : /* @__PURE__ */ h(Select, {
        key: "lessons-project",
        label: "Project",
        options,
        value,
        onSelect: (v) => act({ kind: "project", project: v })()
      }));
    } else {
      out.push(row(options.map((o, i) => button(`lessons-project-${i}`, o.value === value ? `${o.label} (current)` : o.label, { kind: "project", project: o.value }))));
    }
    const windows = [];
    if (from > 0)
      windows.push(button("lessons-projects-prev", "Previous projects", { kind: "projects", offset: Math.max(0, from - PROJECT_WINDOW) }));
    if (from + PROJECT_WINDOW < all.length)
      windows.push(button("lessons-projects-next", "More projects", { kind: "projects", offset: from + PROJECT_WINDOW }));
    if (windows.length > 0)
      out.push(row(windows));
  }
  if (vm.contextNote !== null)
    out.push(line(vm.contextNote, "dim"));
  if (vm.project === null && vm.choices.length > 0)
    out.push(line("Choose a project to see its lessons.", "dim"));
  out.push(row(LESSON_FILTERS.map((f) => button(`lessons-filter-${f}`, vm.filter === f ? `${FILTER_LABELS[f]} (current)` : FILTER_LABELS[f], { kind: "filter", filter: f }))));
  if (Input !== undefined) {
    out.push(/* @__PURE__ */ h(Input, {
      key: "lessons-search",
      label: "Search",
      value: vm.searchDraft ?? vm.search,
      submitLabel: "search",
      onInput: (v) => void lessonsInput($, "search", v, "change"),
      onSubmit: (v) => void lessonsInput($, "search", v, "submit")
    }));
  } else {
    out.push(line("This surface has no text field: search, capture and edit with `sil web`.", "dim"));
  }
  if (!vm.sending)
    out.push(row([button("lesson-capture", "Capture selection", { kind: "capture", view })]));
  if (vm.captureNote !== null)
    out.push(line(vm.captureNote, "dim"));
  if (vm.listError !== null)
    out.push(line(`Lessons unavailable: ${vm.listError}`, "error"));
  if (vm.list !== null) {
    const l = vm.list;
    out.push(line(l.total === 0 ? `No ${FILTER_LABELS[vm.filter].toLowerCase()} lessons here.` : `${FILTER_LABELS[vm.filter]}, page ${vm.page}: ${l.items.length} shown of ${l.total}, read ${l.readAt}.`, "dim"));
    const label = (item) => shown(`${item.important ? "[important] " : ""}${item.effectiveText ?? item.originalText ?? "(no text)"} (${item.sourceStatus})`);
    const rows = l.items.map((item, i) => vm.sending ? line(label(item), "dim") : button(`lesson-row-${i}`, label(item), { kind: "record", index: i }));
    if (rows.length > 0)
      out.push(/* @__PURE__ */ h(Box, {
        flexDirection: "column"
      }, rows));
    const pages = [];
    if (vm.page > 1)
      pages.push(button("lessons-first", "First page", { kind: "first" }), button("lessons-prev", "Previous page", { kind: "prev" }));
    if (l.nextCursor !== null)
      pages.push(button("lessons-more", "Next page", { kind: "more" }));
    if (pages.length > 0)
      out.push(row(pages));
  }
  const field = (name) => ({
    change: (v) => void lessonsInput($, name, v, "change"),
    submit: (v) => void lessonsInput($, name, v, "submit")
  });
  const related = (pattern) => /* @__PURE__ */ h(Button, {
    key: "lesson-related",
    label: `Open related proposal ${shown(pattern, 64)} in Review`,
    onPress: () => {
      consoleAct($, { kind: "section", section: "review" });
      consoleAct($, { kind: "select", pattern });
    }
  });
  out.push(...editorBlocks(vm, { Input, line, row, button, field, related }));
  return /* @__PURE__ */ h(Box, {
    flexDirection: "column"
  }, out);
}
function editorBlocks(vm, p) {
  const { Input, line, row, button, field } = p;
  const ed = vm.editor;
  const target = ed.target;
  if (target === null)
    return [];
  const out = [];
  const capture = ed.mode === "capture";
  out.push(line(capture ? "New capture (not saved yet)" : `Lesson ${shown(encodeLessonKey(target.key), 80)}`, "title"));
  if (ed.error !== null)
    out.push(line(editorErrorText(ed.error.code, ed.error.fields), "error"));
  if (ed.phase === "purged") {
    out.push(line("This lesson was purged. Its curated wording, quotes and history are gone.", "dim"));
    out.push(line(vm.purgeCheck === "verified" ? "A fresh read confirmed the purge." : vm.purgeCheck === "pending" ? "Checking the purge..." : "The purge has not been confirmed by a fresh read yet.", "dim"));
    out.push(row([button("lesson-close", "Close lesson", { kind: "close-editor" })]));
    return out;
  }
  if (ed.phase === "unknown" && ed.pending !== null) {
    out.push(line(`Save outcome unknown for request ${ed.pending.requestId}. It may have been stored. Check before trying again.`, "error"));
    const actions = [button("lesson-check", "Check outcome", { kind: "check" })];
    if (vm.canRetry)
      actions.push(button("lesson-retry", "Send the same request again", { kind: "retry" }));
    out.push(row(actions));
  }
  if (vm.sending && ed.pending !== null)
    out.push(line(`Saving... (request ${ed.pending.requestId})`, "dim"));
  if (vm.captureExists)
    out.push(row([button("lesson-open-existing", "Open the stored lesson", { kind: "open-existing" })]));
  if (isLessonEditorStale(ed)) {
    out.push(line("This lesson changed elsewhere since you started editing. Your wording is kept.", "error"));
    out.push(row([button("lesson-rebase", "Edit from the newer version", { kind: "rebase" })]));
  }
  if (vm.detailError !== null)
    out.push(line(`Lesson detail unavailable: ${vm.detailError}`, "error"));
  const draft = ed.draft;
  if (draft === null) {
    if (ed.gate !== "ready")
      out.push(line("Checking which store holds this lesson...", "dim"));
  } else if (vm.sending) {
    out.push(line("Lesson wording (held while the save runs):", "dim"));
    out.push(line(draft.text, "plain", TEXT_CHARS));
  } else if (Input !== undefined) {
    out.push(/* @__PURE__ */ h(Input, {
      key: "lesson-text",
      label: "Lesson wording",
      value: vm.refused.text ?? draft.text,
      rows: 4,
      autoFocus: true,
      submitLabel: "keep",
      onInput: field("text").change,
      onSubmit: field("text").submit
    }));
    if (vm.dropped.text)
      out.push(line(dropNote("wording"), "error"));
  } else {
    out.push(line(draft.text, "plain", TEXT_CHARS));
  }
  const source = draft?.source ?? null;
  if (capture && source !== null) {
    if (source.kind === "native_selection") {
      out.push(line("Quote (selected text as the terminal reported it, not verified against a transcript):", "dim"));
      out.push(line(source.quote ?? "", "plain", TEXT_CHARS));
    } else if (vm.sending) {
      out.push(line(`Quote: ${source.quote ?? "(none)"}`, "dim", TEXT_CHARS));
      out.push(line(`Reference: ${source.reference ?? "(none)"}`, "dim", TEXT_CHARS));
    } else if (Input !== undefined) {
      out.push(/* @__PURE__ */ h(Input, {
        key: "lesson-quote",
        label: "Quote",
        value: vm.refused.quote ?? source.quote ?? "",
        rows: 3,
        submitLabel: "keep",
        onInput: field("quote").change,
        onSubmit: field("quote").submit
      }));
      if (vm.dropped.quote)
        out.push(line(dropNote("quote"), "error"));
      out.push(/* @__PURE__ */ h(Input, {
        key: "lesson-reference",
        label: "Reference (yours, not verified)",
        value: vm.refused.reference ?? source.reference ?? "",
        submitLabel: "keep",
        onInput: field("reference").change,
        onSubmit: field("reference").submit
      }));
      if (vm.dropped.reference)
        out.push(line(dropNote("reference"), "error"));
    }
    if (vm.scopeToConfirm !== null) {
      const c = vm.scopeToConfirm;
      const label = vm.choices.find((x) => flatProject(x.scope.project) === c.project)?.label ?? c.project;
      out.push(line(c.restored ? `World ${c.world} and project ${label} came back from a reload and could not be checked against this directory. This capture is saved only after you confirm both.` : `World ${c.world} was inferred as the catch-all for this directory, with project ${label}. This capture is saved only after you confirm both.`, "error"));
      out.push(row([button("lesson-confirm-scope", shown(`Confirm world ${c.world}, project ${label}`), { kind: "confirm-scope" })]));
    }
    const id = (value) => value === null ? "unknown" : value;
    out.push(line(`Captured in session ${id(source.captureSessionId)}. Source conversation: ${id(source.sourceConversationId)}. Row: ${id(source.sourceRowId)}. Agent: ${id(source.sourceAgentId)}.`, "dim"));
  }
  const loaded = ed.loaded;
  if (!capture && loaded !== null) {
    out.push(line(`Revision ${loaded.revision}. ${loaded.important ? "Marked important." : "Not marked important."} Source: ${loaded.sourceStatus}.`, "dim"));
    if (loaded.originalText !== null && loaded.originalText !== (loaded.effectiveText ?? loaded.originalText))
      out.push(line(`Original: ${loaded.originalText}`, "dim", TEXT_CHARS));
    if (loaded.source !== null)
      out.push(line(`Quote: ${loaded.source.quote ?? "(none kept)"}${loaded.source.reference ? `. Reference: ${loaded.source.reference}` : ""}`, "dim", TEXT_CHARS));
    const d = vm.detail;
    if (d !== null) {
      if (d.provenance.kind === "existing_lesson" && d.provenance.state === "available")
        out.push(line(`From inbox lesson ${d.provenance.pattern} (${d.provenance.location}), created ${d.provenance.created}.`, "dim"));
      if (d.provenance.kind === "existing_lesson" && d.provenance.state === "unavailable")
        out.push(line(`Source unavailable (${d.provenance.problem}). The curated wording is kept.`, "error"));
      if (d.provenance.kind === "existing_lesson" && d.provenance.state === "conflict")
        out.push(line(`Source conflict: ${d.provenance.copies.length} copies disagree. Nothing can be acknowledged until they are reconciled.`, "error"));
      for (const diag of d.diagnostics.slice(0, 5))
        out.push(line(`Diagnostic: ${diag.code}`, "dim"));
      if (d.historyError)
        out.push(line("History unavailable.", "error"));
      if (d.history !== null) {
        out.push(line(`History, newest first (${d.history.length} of ${d.historyTotal ?? d.history.length}):`, "dim"));
        for (const h2 of d.history)
          out.push(line(`r${h2.revision} ${h2.kind} ${h2.at}${h2.text !== null ? `: ${h2.text}` : ""}${h2.important !== null ? ` important=${h2.important}` : ""}`, "dim"));
      }
      out.push(line(`Read ${d.readAt}.`, "dim"));
    }
  }
  if (!vm.sending) {
    const actions = [];
    if (draft !== null && (capture || vm.dirty))
      actions.push(button("lesson-save", capture ? "Save capture" : "Save wording", { kind: "save" }));
    if (!capture && ed.base !== null)
      actions.push(button("lesson-important", ed.base.important ? "Unmark important" : "Mark important", { kind: "important" }));
    if (!capture && loaded !== null && loaded.sourceStatus === "changed" && loaded.sourceDigest !== null)
      actions.push(button("lesson-acknowledge", "Accept current source", { kind: "acknowledge" }));
    if (!capture && ed.base !== null && vm.purgeConfirm === null)
      actions.push(button("lesson-purge", "Purge", { kind: "purge" }));
    if (!capture && loaded !== null && loaded.relatedPattern !== null && SLUG2.test(loaded.relatedPattern)) {
      actions.push(p.related(loaded.relatedPattern));
    }
    actions.push(button("lesson-close", capture ? "Cancel capture" : "Close lesson", { kind: "close-editor" }));
    out.push(row(actions));
    if (vm.purgeConfirm !== null) {
      const k = vm.purgeConfirm;
      out.push(line(`Purge lesson ${k.kind} ${k.id} in world ${k.world}? This clears its curated wording, quotes and history from this installation. It cannot be undone.`, "error", 600));
      out.push(row([button("lesson-purge-confirm", "Purge permanently", { kind: "purge-confirm" }), button("lesson-purge-cancel", "Keep it", { kind: "purge-cancel" })]));
    }
  }
  return out;
}

// apps/hook-module/src/ui/render.tsx
function bodyColumns(props) {
  const columns = typeof props === "object" && props !== null ? props.bodyColumns : undefined;
  return typeof columns === "number" && Number.isFinite(columns) ? columns : 0;
}
function errorText(err) {
  return err instanceof Error ? err.message : String(err);
}
function registerConsoleViews(on) {
  on("ui.render", { component: "Pane", requestId: "sil-console" }, async ($, e) => {
    const ui = $.ui.resolve(e);
    const { Box, Text, Button, Code } = ui;
    const Select = e.surface !== "mobile" && "Select" in ui ? ui.Select : undefined;
    let state;
    try {
      state = await readConsole($);
    } catch (err) {
      return /* @__PURE__ */ h(Text, {
        color: "error"
      }, `Error: the console state could not be read: ${boundedErrorText(errorText(err))}`);
    }
    const lineOf = (l) => {
      if (l.tone === "title")
        return /* @__PURE__ */ h(Text, {
          bold: true
        }, l.text);
      if (l.tone === "dim")
        return /* @__PURE__ */ h(Text, {
          dimColor: true
        }, l.text);
      if (l.tone === "error")
        return /* @__PURE__ */ h(Text, {
          color: "error"
        }, `Error: ${l.text}`);
      return /* @__PURE__ */ h(Text, null, l.text);
    };
    const buttonOf = (c) => /* @__PURE__ */ h(Button, {
      key: c.key,
      label: c.isCurrent ? `${c.label}${CURRENT_MARK}` : c.label,
      onPress: () => consoleAct($, c.action)
    });
    const blockOf = (b) => {
      if (b.kind === "line")
        return lineOf(b.line);
      if (b.kind === "code")
        return b.diff ? /* @__PURE__ */ h(Code, {
          source: b.source,
          format: "diff"
        }) : /* @__PURE__ */ h(Code, {
          source: b.source
        });
      if (b.kind === "select") {
        const key = b.key;
        const onSelect = (value) => {
          const action = selectAction(state, key, value);
          if (action !== null)
            consoleAct($, action);
        };
        if (Select === undefined)
          return /* @__PURE__ */ h(Text, {
            color: "error"
          }, "Error: this surface has no picker.");
        return b.value === null ? /* @__PURE__ */ h(Select, {
          key,
          label: b.label,
          options: b.options,
          onSelect
        }) : /* @__PURE__ */ h(Select, {
          key,
          label: b.label,
          options: b.options,
          value: b.value,
          onSelect
        });
      }
      const buttons = b.controls.map(buttonOf);
      if (b.label === undefined)
        return /* @__PURE__ */ h(Box, {
          flexDirection: b.direction,
          gap: 1
        }, buttons);
      return /* @__PURE__ */ h(Box, {
        flexDirection: b.direction,
        gap: 1
      }, /* @__PURE__ */ h(Text, {
        dimColor: true
      }, b.label), buttons);
    };
    const blocks = consoleView(state, { columns: bodyColumns(e.props), canSelect: Select !== undefined });
    const drawn = blocks.map(blockOf);
    if (state.section === "activity") {
      try {
        drawn.push(await drawLessons($, ui, e, state.world, bodyColumns(e.props)));
      } catch (err) {
        drawn.push(/* @__PURE__ */ h(Text, {
          color: "error"
        }, `Error: the lessons view could not be drawn: ${boundedErrorText(errorText(err))}`));
      }
    }
    return /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, drawn);
  });
}

// apps/hook-module/src/ui/register.ts
var PANE_TITLE = "Self-improvement loop";
var FALLBACK = "Use `sil` or `sil web` instead.";
var WRITE_ATTEMPTS = 5;
function errorText2(err) {
  return err instanceof Error ? err.message : String(err);
}
var timer = null;
var inFlight = null;
var writes2 = Promise.resolve();
var requestSeq = 0;
var lifecycle = 0;
var active = false;
var againFor = null;
function resetUiForTests() {
  timer = null;
  inFlight = null;
  writes2 = Promise.resolve();
  requestSeq = 0;
  lifecycle = 0;
  active = false;
  againFor = null;
  resetLessonsForTests();
}
function isCurrent(life) {
  return active && life === lifecycle;
}
function activate() {
  lifecycle += 1;
  active = true;
  againFor = null;
}
function deactivate() {
  lifecycle += 1;
  active = false;
  againFor = null;
  stopTimer();
}
function log($, text) {
  try {
    $.ui.log(`self-improvement-loop: ${text}`);
  } catch {}
}
async function readConsole($) {
  const held = await $.state.get({ plugin: "self-improvement-loop", key: "console" });
  return parseConsoleState(held.value).state;
}
function writeConsole($, change) {
  const run = async () => {
    for (let attempt = 0;attempt < WRITE_ATTEMPTS; attempt++) {
      const held = await $.state.get({ plugin: "self-improvement-loop", key: "console" });
      const parsed = parseConsoleState(held.value);
      const next = change(parsed.state);
      if (next === parsed.state && parsed.reset === "none")
        return next;
      const set = await $.state.set({ plugin: "self-improvement-loop", key: "console" }, next, { ifVersion: held.version });
      if (set.isSet)
        return next;
    }
    throw new Error(`the console state kept changing under ${WRITE_ATTEMPTS} attempts to write it`);
  };
  const result = writes2.then(run, run);
  writes2 = result.catch(() => {
    return;
  });
  return result;
}
async function paneVisibility($) {
  const panes = await $.ui.panes();
  const pane = panes.find((p) => p.id === "sil-console");
  if (!pane)
    return "closed";
  return pane.isPlaced && pane.isShown ? "shown" : "hidden";
}
function startTimer($) {
  if (timer !== null)
    return;
  timer = $.clock.every(CONSOLE_REFRESH_MS, () => {
    refresh($);
  });
}
function stopTimer() {
  timer?.cancel();
  timer = null;
}
function refresh($) {
  if (!active)
    return Promise.resolve();
  const life = lifecycle;
  if (inFlight !== null) {
    againFor = life;
    return inFlight;
  }
  const run = refreshOnce($, life).catch((err) => log($, `the console could not refresh: ${errorText2(err)}`)).finally(() => {
    inFlight = null;
    const follow = againFor;
    againFor = null;
    if (follow !== null && isCurrent(follow))
      refresh($);
  });
  inFlight = run;
  return run;
}
function writeIfCurrent($, life, change) {
  return writeConsole($, (s) => isCurrent(life) ? change(s) : s);
}
async function refreshOnce($, life) {
  const visibility = await paneVisibility($);
  if (!isCurrent(life))
    return;
  if (visibility === "closed") {
    deactivate();
    return;
  }
  if (visibility === "hidden")
    return;
  const before = await readConsole($);
  const generation = before.generation;
  const started = await writeIfCurrent($, life, (s) => beginConsoleRefresh(s, generation));
  if (!isCurrent(life) || started.generation !== generation)
    return;
  let after;
  try {
    const cwd = await $.session.cwd();
    requestSeq += 1;
    const request = { version: 1, requestId: `sil-${generation}-${requestSeq}`, reads: consoleReads(started, cwd) };
    if (!isCurrent(life))
      return;
    const response = await readControl($, request);
    const completedAt = new Date(await $.clock.now()).toISOString();
    after = await writeIfCurrent($, life, (s) => reconcileConsoleWorld(applyConsoleRead(s, generation, response, completedAt)));
  } catch (err) {
    const message = err instanceof Error && err.name === "ControlTransportError" ? err.message : "the console could not read the loop.";
    after = await writeIfCurrent($, life, (s) => failConsoleRead(s, generation, message));
  }
  if (isCurrent(life) && after.generation !== generation && after.world !== null && after.world !== before.world)
    againFor = life;
  if (isCurrent(life) && after.section === "activity")
    refreshLessons($);
}
function begin($) {
  activate();
  startTimer($);
  return { life: lifecycle, ready: writeConsole($, invalidateConsole) };
}
async function restart($) {
  const { life, ready } = begin($);
  await ready;
  if (isCurrent(life))
    refresh($);
}
function consoleAct($, action) {
  const bind = () => active ? { life: lifecycle, ready: Promise.resolve() } : begin($);
  const readFor = (life) => isCurrent(life) ? refresh($) : Promise.resolve();
  const rescope = (change) => {
    const { life } = bind();
    return writeIfCurrent($, life, change).then(() => readFor(life));
  };
  let done;
  switch (action.kind) {
    case "refresh": {
      const { life, ready } = bind();
      done = ready.then(() => readFor(life));
      break;
    }
    case "close":
      done = $.ui.close({ id: "sil-console" }).then(() => closeConsole($), (err) => log($, `the console could not close: ${errorText2(err)}`));
      break;
    case "section":
      done = rescope((s) => selectConsoleSection(s, action.section));
      break;
    case "world":
      if (!lessonsWorldChanging($, action.world))
        return;
      done = rescope((s) => chooseConsoleWorld(s, action.world));
      break;
    case "list":
      done = rescope((s) => setConsoleListOffset(s, action.offset));
      break;
    case "lessons":
      done = rescope((s) => setLessonsOffset(s, action.offset));
      break;
    case "worlds":
      done = active ? writeIfCurrent($, lifecycle, (s) => setWorldOffset(s, action.offset)) : writeConsole($, (s) => setWorldOffset(s, action.offset));
      break;
    case "select":
      done = rescope((s) => selectConsolePattern(s, action.pattern));
      break;
    case "part":
      done = rescope((s) => setProposalPart(s, action.part));
      break;
    case "page":
      done = rescope((s) => turnProposalPage(s, action.to));
      break;
    case "reload-proposal":
      done = rescope(reloadProposal);
      break;
  }
  done.catch((err) => log($, `the console control failed: ${errorText2(err)}`));
}
async function closeConsole($) {
  if (!active && timer === null)
    return;
  deactivate();
  try {
    await writeConsole($, invalidateConsole);
  } catch (err) {
    log($, `the console could not record its close: ${errorText2(err)}`);
  }
}
function endConsoleSession($) {
  if (!active && timer === null)
    return Promise.resolve();
  deactivate();
  return writeConsole($, invalidateConsole).then(() => {
    return;
  }, () => {
    return;
  });
}
function registerUi(on) {
  on("session.start", async ($, e, next) => {
    try {
      await $.command.register({
        name: "sil",
        description: "Open the self-improvement loop console"
      });
    } catch (err) {
      log($, `/sil is unavailable this session: ${errorText2(err)}. ${FALLBACK}`);
    }
    let up = false;
    try {
      up = await paneVisibility($) !== "closed";
      if (up)
        await restart($);
    } catch (err) {
      log($, `the console could not resume after a reload: ${errorText2(err)}`);
    }
    if (up)
      await resumeLessonsLogged($);
    return next(e);
  });
  on("command.run", { command: "sil" }, async ($, e) => {
    const lesson = lessonCommand(e.args);
    let selection = null;
    if (lesson.kind === "capture") {
      try {
        selection = await readCaptureSelection($, null);
      } catch {
        selection = { source: null, note: "Selection unavailable. Paste the relevant passage or add a reference." };
      }
    }
    await resumeLessonsLogged($);
    let placed;
    try {
      placed = await $.ui.open(lesson.kind === "none" ? { id: "sil-console", title: PANE_TITLE } : { id: "sil-console", title: PANE_TITLE, focus: true });
    } catch (err) {
      return { text: `Could not open the self-improvement loop console: ${errorText2(err)}. ${FALLBACK}` };
    }
    if (lesson.kind !== "none") {
      try {
        await writeConsole($, (s) => selectConsoleSection(s, "activity"));
        await restart($);
        await refresh($);
        const world = (await readConsole($)).world;
        const text = lesson.kind === "capture" ? await openLessonCapture($, selection ?? { source: null, note: null }, world) ?? "Opened a lesson capture in the self-improvement loop console." : lesson.kind === "lesson" ? await openLessonByKey($, lesson.key, world) : "Usage: /sil, /sil capture, or /sil lesson <encoded key>.";
        return { text: placed.isPlaced ? text : `${text} This surface cannot show the pane yet (${placed.reason}). ${FALLBACK}` };
      } catch (err) {
        log($, `the lesson view could not open: ${errorText2(err)}`);
        return { text: `The lesson view could not open. ${FALLBACK}` };
      }
    }
    try {
      await restart($);
    } catch (err) {
      log($, `the console could not start refreshing: ${errorText2(err)}`);
    }
    if (placed.isPlaced)
      return { text: "Opened the self-improvement loop console." };
    return {
      text: `The self-improvement loop console is open but this surface cannot show it yet (${placed.reason}). ${FALLBACK}`
    };
  });
  on("ui.close", { id: "sil-console" }, async ($, e, next) => {
    const result = await next(e);
    if (result !== null && typeof result === "object" && typeof result.deny === "string")
      return result;
    await closeConsole($);
    return result;
  });
  registerConsoleViews(on);
}
async function resumeLessonsLogged($) {
  try {
    await resumeLessons($);
  } catch (err) {
    log($, `the lesson editor could not resume after a reload: ${errorText2(err)}`);
  }
}
function lessonCommand(args) {
  const words = args.trim().split(/\s+/).filter((w) => w !== "");
  if (words[0] === "capture" && words.length === 1)
    return { kind: "capture" };
  if (words[0] === "lesson")
    return words.length === 2 ? { kind: "lesson", key: words[1] } : { kind: "usage" };
  return { kind: "none" };
}

// apps/hook-module/src/register.ts
function resetForTests2() {
  resetForTests();
  resetUiForTests();
  guardPid = null;
  guardPidResolved = false;
}
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
function isRecord9(v) {
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
  const source = isRecord9(e) ? e : {};
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
function onRegistrationError() {
  return;
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
      parts.push(sessionStartStatusLine(state.snapshotPresent, state.pluginRoot));
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
  }).catch(onRegistrationError);
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
  }).catch(onRegistrationError);
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
  }).catch(onRegistrationError);
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
  }).catch(onRegistrationError);
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
  }).catch(onRegistrationError);
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
  }).catch(onRegistrationError);
  on("session.end", async ($, e, next) => {
    endConsoleSession($);
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
  registerUi(on);
}
function recordToolUsage(state, toolName, rawInput) {
  const toolInput = isRecord9(rawInput) ? rawInput : {};
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
