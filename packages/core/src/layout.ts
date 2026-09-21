// Filesystem layout as pure arithmetic on strings, with no Node globals of
// any kind. paths.ts feeds it the real environment and home dir; the Claude
// Code hooks module, which runs in a sandbox that has neither, feeds it the
// engine's own env reader. Both get byte-identical paths out.
//
// The path helpers below reproduce node:path's posix behaviour, trailing
// slash and all, because paths.ts must keep returning exactly what join()
// returned before this file existed.

export interface LayoutEnv {
  /** One environment variable: the real environment in Node, the engine's
   * own env lookup inside the hooks module. */
  get(name: string): string | undefined;
  home: string;
}

export interface Layout {
  configDir(): string;
  stateDir(): string;
  dataDir(): string;
  queueDir(bucket: "pending" | "done" | "failed"): string;
  usageEventsFile(): string;
  hookRunsFile(): string;
  payloadSamplesFile(world: string): string;
  nudgeFiresFile(): string;
  inboxDir(world: string): string;
  sessionDir(sessionId: string): string;
  workerLockFile(): string;
  hookSnapshotFile(): string;
  logFile(name: string): string;
  worldDir(world: string): string;
  defaultTarget(world: string): string;
}

const SLASH = 47;

/** node:path's posix normalize: collapse repeated separators, drop "."
 * segments, resolve ".." where it can, keep a trailing slash. */
function normalize(p: string): string {
  const absolute = p.charCodeAt(0) === SLASH;
  const trailingSlash = p.length > 1 && p.charCodeAt(p.length - 1) === SLASH;
  const out: string[] = [];
  for (const segment of p.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  let joined = out.join("/");
  if (absolute) joined = `/${joined}`;
  else if (joined === "") joined = ".";
  if (trailingSlash && joined !== "/") joined += "/";
  return joined;
}

export function posixJoin(...parts: string[]): string {
  let joined = "";
  for (const part of parts) {
    if (part.length === 0) continue;
    joined = joined.length === 0 ? part : `${joined}/${part}`;
  }
  return joined.length === 0 ? "." : normalize(joined);
}

export function posixDirname(p: string): string {
  if (p.length === 0) return ".";
  const absolute = p.charCodeAt(0) === SLASH;
  let end = -1;
  let sawSlash = true;
  for (let i = p.length - 1; i >= 1; i--) {
    if (p.charCodeAt(i) === SLASH) {
      if (!sawSlash) {
        end = i;
        break;
      }
    } else {
      sawSlash = false;
    }
  }
  if (end === -1) return absolute ? "/" : ".";
  if (absolute && end === 1) return "//";
  return p.slice(0, end);
}

export function posixBasename(p: string): string {
  let start = 0;
  let end = -1;
  let sawSlash = true;
  for (let i = p.length - 1; i >= 0; i--) {
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

/** Both arguments absolute and already normalised. A shared name prefix is
 * not containment: /a/bc is not under /a/b. */
export function isWithin(child: string, parent: string): boolean {
  if (child === parent) return true;
  if (parent === "/") return true;
  return child.startsWith(`${parent}/`);
}

export function expandHomeWith(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return posixJoin(home, p.slice(2));
  return p;
}

const SAFE_CHAR = /[\p{L}\p{N}._-]/u;

/** Path component from an identifier: no separators, no traversal.
 *
 * Unicode letters and digits are kept. Folding them to "_" made every
 * non-ASCII name collide: Koleżka and Koleźka both became Kole_ka and shared
 * one directory. NFC first so the same name typed two ways lands on one path,
 * which matters on filesystems that store bytes rather than normalize. */
export function safeComponent(name: string): string {
  const cleaned = Array.from(name.normalize("NFC"), (c) => (SAFE_CHAR.test(c) ? c : "_")).join("");
  return cleaned === "" || cleaned === "." || cleaned === ".." ? "_" : cleaned;
}

function envPath(env: LayoutEnv, name: string, fallback: string): string {
  const raw = env.get(name);
  return raw && raw.length > 0 ? expandHomeWith(raw, env.home) : fallback;
}

/** Same precedence as paths.ts: SIL_*_DIR, else XDG_*_HOME, else
 * ~/.config | ~/.local/state | ~/.local/share, each with ~ expansion. */
export function layout(env: LayoutEnv): Layout {
  const configDir = (): string =>
    envPath(env, "SIL_CONFIG_DIR", posixJoin(envPath(env, "XDG_CONFIG_HOME", posixJoin(env.home, ".config")), "self-improvement-loop"));
  const stateDir = (): string =>
    envPath(env, "SIL_STATE_DIR", posixJoin(envPath(env, "XDG_STATE_HOME", posixJoin(env.home, ".local", "state")), "self-improvement-loop"));
  const dataDir = (): string =>
    envPath(env, "SIL_DATA_DIR", posixJoin(envPath(env, "XDG_DATA_HOME", posixJoin(env.home, ".local", "share")), "self-improvement-loop"));
  const worldDir = (world: string): string => posixJoin(dataDir(), "worlds", safeComponent(world));

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
    defaultTarget: (world) => posixJoin(worldDir(world), "learned"),
  };
}
