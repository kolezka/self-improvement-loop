// Worker kick: spawn a detached `worker --once` when there is pending work
// and no worker is already running. Ported from sil/hook.py's
// _worker_lock_pid, _worker_running, _curriculum_due_for_any_world,
// _has_pending_work, _maybe_kick_worker.
//
// Deviation from sil/hook.py: Python gates the kick on `shutil.which("uv")`
// because it invokes `uv run --project <root> sil worker --once`. The hook
// here always runs under Bun already, so there is no equivalent "is the
// runtime available" check; the kick command is `bun dist/cli.js` (or the
// source entry when unbuilt), per this port's ground rules.

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import * as paths from "@sil/core/paths";
import type { HookSnapshot, WorkerConfig } from "./snapshot.ts";
import { DEFAULT_WORKER, defaultWorld } from "./snapshot.ts";

const WORKER_KICK_THROTTLE_MS = 15 * 60 * 1000;

function lastKickPath(): string {
  return `${paths.stateDir()}/last-kick`;
}

function curriculumMarkerPath(worldName: string): string {
  return `${paths.stateDir()}/last-curriculum-${worldName}`;
}

function workerLockPid(): number | null {
  try {
    const text = readFileSync(paths.workerLockFile(), "utf8").trim();
    const pid = Number.parseInt(text, 10);
    return Number.isFinite(pid) ? pid : null;
  } catch {
    return null;
  }
}

/** sil.worker.Lock truncates its lock file on a clean exit but never
 * unlinks it, so the file's mere existence says nothing. Read the pid it
 * names and probe that process directly, mirroring Python's os.kill(pid, 0). */
function workerRunning(): boolean {
  const pid = workerLockPid();
  if (pid === null) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "EPERM") return true; // exists, owned by someone else
    return false; // ESRCH: no such process
  }
}

/** True if any world's curriculum marker is missing or older than the
 * interval. One kick runs the worker once for every world, so any single
 * world being due is reason enough. */
function curriculumDueForAnyWorld(snapshot: HookSnapshot, intervalMinutes: number): boolean {
  const worlds = snapshot.worlds?.length ? snapshot.worlds : [defaultWorld()];
  const intervalS = Number.isFinite(intervalMinutes) ? Math.max(intervalMinutes, 0) * 60 : DEFAULT_WORKER.curriculum_interval_minutes * 60;
  for (const w of worlds) {
    if (!w || typeof w !== "object") continue;
    const marker = curriculumMarkerPath(w.name || "default");
    try {
      const st = statSync(marker);
      if (Date.now() / 1000 - st.mtimeMs / 1000 >= intervalS) return true;
    } catch {
      return true; // marker missing
    }
  }
  return false;
}

function hasPendingWork(snapshot: HookSnapshot, workerCfg: WorkerConfig): boolean {
  try {
    if (readdirSync(paths.queueDir("pending")).length > 0) return true;
  } catch {
    // queue dir missing: nothing pending
  }
  const interval = workerCfg.curriculum_interval_minutes ?? DEFAULT_WORKER.curriculum_interval_minutes;
  return curriculumDueForAnyWorld(snapshot, interval);
}

function resolveWorkerCommand(pluginRoot: string): string[] {
  const built = join(pluginRoot, "dist", "cli.js");
  if (existsSync(built)) return ["bun", built, "worker", "--once"];
  return ["bun", "run", join(pluginRoot, "apps", "cli", "src", "main.ts"), "worker", "--once"];
}

/** Test hook: when set, a kick appends its argv (JSON array, one line) to
 * this file instead of actually spawning a process. */
let spawnLogOverride: string | null = null;
export function setSpawnLogForTests(path: string | null): void {
  spawnLogOverride = path;
}

function spawnLogPath(): string | null {
  return spawnLogOverride ?? process.env["SIL_TEST_SPAWN_LOG"] ?? null;
}

export function maybeKickWorker(snapshot: HookSnapshot): void {
  if (!existsSync(paths.hookSnapshotFile())) return; // never `sil init`ed: nothing to kick
  const workerCfg = snapshot.worker ?? DEFAULT_WORKER;
  if (workerCfg.auto_kick === false) return;
  if (workerRunning()) return;

  const lastKick = lastKickPath();
  try {
    const age = Date.now() - statSync(lastKick).mtimeMs;
    if (age < WORKER_KICK_THROTTLE_MS) return;
  } catch {
    // no last-kick file yet: not throttled
  }

  if (!hasPendingWork(snapshot, workerCfg)) return;

  try {
    mkdirSync(paths.stateDir(), { recursive: true });
    const now = new Date();
    if (existsSync(lastKick)) utimesSync(lastKick, now, now);
    else writeFileSync(lastKick, "");
  } catch {
    return;
  }

  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"] || snapshot.plugin_root || paths.pluginRoot();
  const cmd = resolveWorkerCommand(pluginRoot);

  const testLog = spawnLogPath();
  if (testLog) {
    try {
      writeFileSync(testLog, `${JSON.stringify(cmd)}\n`, { flag: "a" });
    } catch {
      // test hook failure must not throw in a code path that mimics prod
    }
    return;
  }

  const logPath = paths.logFile("worker");
  let fd: number;
  try {
    mkdirSync(`${paths.stateDir()}/logs`, { recursive: true });
    fd = openSync(logPath, "a");
  } catch {
    return;
  }
  try {
    const child = spawn(cmd[0]!, cmd.slice(1), {
      detached: true,
      stdio: ["ignore", fd, fd],
      env: process.env,
      cwd: pluginRoot,
    });
    child.unref();
  } catch {
    // a spawn failure must never propagate out of the hook
  } finally {
    try {
      closeSync(fd);
    } catch {
      // fd already closed by the child holding its own dup
    }
  }
}
