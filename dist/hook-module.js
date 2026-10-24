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

// apps/hook-module/src/ui/pages.ts
var PROPOSAL_PAGE_MAX_BYTES = 65536;
var PROPOSAL_PAGE_MAX_LINES = 200;
var REVIEWED_STATE_RE = /^[0-9a-f]{64}$/;
function isPlainObject2(value) {
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
  if (!isPlainObject2(value) || !hasExactKeys(value, LIST_KEYS))
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
  if (!isPlainObject2(value) || !hasExactKeys(value, PAGE_KEYS))
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
    if (!isPlainObject2(o) || !hasExactKeys(o, ["line", "bytes"]) || !isCount(o.line) || !isCount(o.bytes))
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
  if (!isPlainObject2(value) || !hasExactKeys(value, ["worlds", "selectedWorld", "resolutionError", "initialized"]))
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
var STATE_KEYS = [...TASK5_KEYS, "lessonsOffset", "worldOffset"];
function isControlResult(value) {
  if (!isPlainObject2(value))
    return false;
  if (value.ok === true)
    return hasExactKeys(value, ["ok", "value"]);
  if (value.ok !== false || !hasExactKeys(value, ["ok", "error"]))
    return false;
  const error = value.error;
  return isPlainObject2(error) && hasExactKeys(error, ["code", "message", "retryable"]) && typeof error.code === "string" && typeof error.message === "string" && typeof error.retryable === "boolean";
}
function isGeneration(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function isProposalView(value) {
  if (!isPlainObject2(value) || !hasExactKeys(value, ["part", "offset", "back", "reviewedState"]))
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
  if (!isPlainObject2(v.results))
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
  if (!isPlainObject2(value) || !hasExactKeys(value, STATE_KEYS) || !isTask5Fields(value))
    return false;
  return isCount(value.lessonsOffset) && isCount(value.worldOffset);
}
function parseConsoleState(value) {
  if (value === undefined)
    return { state: initialConsoleState(), reset: "none" };
  if (isPlainObject2(value) && hasExactKeys(value, ["opens"]) && typeof value.opens === "number") {
    return { state: initialConsoleState(), reset: "legacy" };
  }
  if (isPlainObject2(value) && hasExactKeys(value, TASK4_KEYS) && isTask4Fields(value)) {
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
  if (isPlainObject2(value) && hasExactKeys(value, TASK5_KEYS) && isTask5Fields(value)) {
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
  const held = isPlainObject2(value) && isGeneration(value.generation) ? value.generation : 0;
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
function isRecord7(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function str3(value) {
  return typeof value === "string" ? value : null;
}
function workerLine(state) {
  if (!Object.hasOwn(state.results, WORKER_READ))
    return null;
  const result = state.results[WORKER_READ];
  if (!result.ok)
    return { text: `Worker status (global) unavailable: ${result.error.code}: ${result.error.message}`, tone: "error" };
  const v = result.value;
  if (!isRecord7(v) || !isCount(v.pending) || !isCount(v.done) || !isCount(v.failed)) {
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
    const pattern = isRecord7(item) ? str3(item.pattern) : null;
    if (pattern === null || !SLUG.test(pattern)) {
      odd.push(line("A proposal came back in an unexpected shape and is not shown.", "error"));
      continue;
    }
    const type = isRecord7(item) ? str3(item.artifact_type) ?? "?" : "?";
    const status = isRecord7(item) ? str3(item.status) ?? "?" : "?";
    items.push(control(`proposal-${pattern}`, `${pattern} (${row(type)}, ${row(status)})`, { kind: "select", pattern }, state.selectedPattern === pattern));
  }
  return [controls("proposals", items, "column"), ...odd];
}
function artifactRows(page) {
  return page.items.map((item) => {
    if (!isRecord7(item) || str3(item.pattern) === null)
      return line("An artifact came back in an unexpected shape and is not shown.", "error");
    const served = str3(item.served_by);
    const reflections = isCount(item.reflections) ? `${item.reflections} reflections` : "reflections unknown";
    return line(row(`${item.pattern}: ${str3(item.artifact_type) ?? "?"}, ${str3(item.status) ?? "?"}, ${reflections}${served ? `, served by ${served}` : ""}`));
  });
}
function reflectionRows(page) {
  return page.items.map((item) => {
    if (!isRecord7(item) || str3(item.pattern) === null)
      return line("A reflection came back in an unexpected shape and is not shown.", "error");
    return line(row(`${str3(item.created) ?? "?"} ${item.pattern}: ${str3(item.lesson) ?? "(no lesson)"}`));
  });
}
function lessonRows(page) {
  return page.items.map((item) => {
    if (!isRecord7(item) || str3(item.pattern) === null)
      return line("A lesson came back in an unexpected shape and is not shown.", "error");
    return line(row(`${item.pattern}: ${str3(item.text) ?? "?"}`));
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
  if (!isRecord7(v) || !Array.isArray(v.pending) || !Array.isArray(v.done) || !Array.isArray(v.failed)) {
    return [line("Queue came back in an unexpected shape and is not shown.", "error")];
  }
  const entry = (bucket, e) => {
    if (!isRecord7(e) || str3(e.session_id) === null)
      return line("A queue entry came back in an unexpected shape and is not drawn.", "error");
    const result = str3(e.result);
    return line(row(`${bucket}: ${e.session_id} (${str3(e.world) ?? "?"}) last stop ${str3(e.last_stop) ?? "?"}${result ? `: ${result}` : ""}`));
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
  const hidden = isRecord7(v.hidden) ? v.hidden : {};
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
  if (!isRecord7(v) || typeof v.exists !== "boolean" || !Array.isArray(v.lines) || !v.lines.every((l) => typeof l === "string")) {
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
    return /* @__PURE__ */ h(Box, {
      flexDirection: "column"
    }, blocks.map(blockOf));
  });
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

// apps/hook-module/src/ui/register.ts
var PANE_TITLE = "Self-improvement loop";
var FALLBACK = "Use `sil` or `sil web` instead.";
var WRITE_ATTEMPTS = 5;
function errorText2(err) {
  return err instanceof Error ? err.message : String(err);
}
var timer = null;
var inFlight = null;
var writes = Promise.resolve();
var requestSeq = 0;
var lifecycle = 0;
var active = false;
var againFor = null;
function resetUiForTests() {
  timer = null;
  inFlight = null;
  writes = Promise.resolve();
  requestSeq = 0;
  lifecycle = 0;
  active = false;
  againFor = null;
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
  const result = writes.then(run, run);
  writes = result.catch(() => {
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
    try {
      if (await paneVisibility($) !== "closed")
        await restart($);
    } catch (err) {
      log($, `the console could not resume after a reload: ${errorText2(err)}`);
    }
    return next(e);
  });
  on("command.run", { command: "sil" }, async ($) => {
    let placed;
    try {
      placed = await $.ui.open({ id: "sil-console", title: PANE_TITLE });
    } catch (err) {
      return { text: `Could not open the self-improvement loop console: ${errorText2(err)}. ${FALLBACK}` };
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
function isRecord8(v) {
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
  const source = isRecord8(e) ? e : {};
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
  const toolInput = isRecord8(rawInput) ? rawInput : {};
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
