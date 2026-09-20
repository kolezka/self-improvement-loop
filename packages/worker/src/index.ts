// Background worker: reflect, curriculum, feedback, outline export. Runs
// under a single-instance lock; a queue entry's failure never stops the run.

import { closeSync, openSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  ConfigError,
  fsx,
  loadConfig,
  LockHeld,
  paths,
  ProviderError,
  writeHookSnapshot,
  type Config,
  type QueueEntry,
  type World,
} from "@sil/core";
import type { ChatFn } from "@sil/providers";
import { reflectSession } from "@sil/critic";
import { rebuild as rebuildScorecards } from "@sil/feedback";
import { entryPath, listQueue, loadEntry, moveEntry, writeEntry, type Bucket } from "@sil/store";
import { countToolUses } from "@sil/transcript";
import { run as curriculumRun } from "@sil/curriculum";
import { exportNew } from "./outline.ts";

export interface RunSummary { reflected: string[]; failed: string[]; skipped: string[]; curriculum: Record<string, unknown>; duration_s: number; locked?: boolean }
export interface WorkerStatus { lock_held: boolean; lock_pid: number | null; pending: number; done: number; failed: number; last_run: string | null; last_summary: RunSummary | null; last_curriculum: Record<string, string> }
export interface RunOnceOptions { worldName?: string; reflect?: boolean; curriculum?: boolean; chat?: ChatFn }

export const MAX_ATTEMPTS = 3;

// --- lock --------------------------------------------------------------------

function readPid(path: string): number | null {
  const text = fsx.readTextOr(path, "").trim();
  if (!text) return null;
  const pid = Number.parseInt(text, 10);
  return Number.isFinite(pid) ? pid : null;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    return err.code === "EPERM"; // exists, owned by someone else
  }
}

// The file is created empty and its pid written a moment later, so an empty lock
// file can be a live acquire microseconds old. Re-read before calling it a
// leftover; a crash between the two writes costs this long, once.
const PID_SETTLE_TRIES = 5;
const PID_SETTLE_MS = 10;
// How long a reclaim waits before believing it won. Two processes can decide the
// same crashed lock is theirs; the last write is the one that counts, and the
// others find a pid that is not theirs.
const RECLAIM_SETTLE_MS = 60;

/** The pid in the lock file once it has stopped being empty, or null.
 *
 * Reclaiming on the first empty read is how two processes both end up holding
 * the lock: one is between its create and its write, the other calls the file
 * abandoned and takes it. */
function settledPid(path: string): number | null {
  for (let i = 0; i < PID_SETTLE_TRIES; i++) {
    const pid = readPid(path);
    if (pid !== null) return pid;
    if (!fsx.exists(path)) return null;
    Bun.sleepSync(PID_SETTLE_MS);
  }
  return readPid(path);
}

/** Single-instance guard on `paths.workerLockFile()`. A lock file whose
 * recorded pid is no longer alive, missing, or empty is reclaimed. */
export class Lock {
  private readonly path: string;

  constructor() {
    this.path = paths.workerLockFile();
  }

  /** Take the lock, or throw LockHeld.
   *
   * The exclusive create is the whole guard: it is one atomic operation, so two
   * processes racing for a free lock cannot both win. Reading the pid and then
   * writing left a window in which both read "free" and both wrote, and the
   * second write silently replaced the first holder. */
  acquire(): void {
    fsx.ensureDir(dirname(this.path));
    if (this.create()) return;
    const pid = settledPid(this.path);
    if (pid !== null && pidAlive(pid)) throw new LockHeld(`worker lock held: ${this.path}`);

    // A crashed worker's file: no pid, an unparsable one, or a dead one. It is
    // overwritten in place, never unlinked and recreated: measured with five
    // processes racing, unlink-then-create gave two holders, because each
    // reclaimer removed the file another had just made. A rename leaves no
    // moment in which the lock is absent, so nothing on the fast path above can
    // slip through, and only genuine reclaimers compete. The last write wins and
    // the rest read a pid that is not theirs.
    fsx.atomicWrite(this.path, String(process.pid));
    Bun.sleepSync(RECLAIM_SETTLE_MS);
    if (readPid(this.path) !== process.pid) throw new LockHeld(`worker lock held: ${this.path}`);
  }

  release(): void {
    // Truncate first. If the unlink then fails, what is left reads as free.
    try {
      writeFileSync(this.path, "", "utf8");
    } catch {
      // no lock file to truncate
    }
    try {
      unlinkSync(this.path);
    } catch {
      // already gone
    }
  }

  static held(): boolean {
    const pid = readPid(paths.workerLockFile());
    return pid !== null && pidAlive(pid);
  }

  /** True when this call created the file, false when it already existed. */
  private create(): boolean {
    let fd: number;
    try {
      fd = openSync(this.path, "wx");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EEXIST") return false;
      throw e;
    }
    try {
      writeSync(fd, String(process.pid));
    } finally {
      closeSync(fd);
    }
    return true;
  }
}

export async function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const lock = new Lock();
  lock.acquire();
  try {
    return await fn();
  } finally {
    lock.release();
  }
}

// --- queue helpers -------------------------------------------------------------

/** Move an entry into a terminal bucket and reap its session dir. Unlike
 * `@sil/store`'s `moveEntry`, this also drops the session's working dir. */
export function moveToTerminal(entry: QueueEntry, to: "done" | "failed", result: string): void {
  moveEntry(entry, "pending", to, result);
  reapSessionDir(entry.session_id);
}

export function reapSessionDir(sessionId: string): void {
  const dir = paths.sessionDir(sessionId);
  if (!fsx.exists(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  log({ action: "reap_session_dir", session_id: sessionId, result: "removed" });
}

/** Catch session dirs whose queue entry never closed (crash, manual
 * deletion). Bounded per run so a huge backlog cannot stall a worker pass. */
export function reapStaleSessionDirs(now: Date, maxAgeDays = 7, limit = 500): number {
  const root = join(paths.stateDir(), "sessions");
  let names: string[];
  try {
    names = readdirSync(root).sort();
  } catch {
    return 0;
  }
  const cutoff = now.getTime() - maxAgeDays * 86_400_000;
  let removed = 0;
  for (const name of names) {
    if (removed >= limit) break;
    const p = join(root, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isDirectory()) continue;
    if (st.mtimeMs < cutoff) {
      rmSync(p, { recursive: true, force: true });
      removed += 1;
    }
  }
  if (removed) log({ action: "reap_stale_sessions", result: `removed ${removed}` });
  return removed;
}

/** Keep only the newest `keep` entries (by last_stop) in a queue bucket so
 * done/failed cannot grow without bound. */
export function pruneQueueBucket(bucket: Bucket, keep = 500): number {
  const entries = listQueue(bucket);
  if (entries.length <= keep) return 0;
  const sorted = [...entries].sort((a, b) => (a.last_stop < b.last_stop ? 1 : a.last_stop > b.last_stop ? -1 : 0));
  const stale = sorted.slice(keep);
  for (const e of stale) {
    try {
      rmSync(entryPath(bucket, e.session_id), { force: true });
    } catch {
      // already gone
    }
  }
  log({ action: "prune_queue", bucket, result: `removed ${stale.length}` });
  return stale.length;
}

export function skipSession(sessionId: string): boolean {
  const entry = loadEntry("pending", sessionId);
  if (entry === null) return false;
  moveToTerminal(entry, "done", "skipped by operator");
  return true;
}

// A transcript that is not on disk is not a broken reflection: Claude Code
// writes none for `claude --print --no-session-persistence`, and an old one
// can be cleaned up before the worker gets to it. Either way there is nothing
// to read, so the entry retires as skipped and `failed` keeps meaning
// "reflection ran and broke".
const NO_TRANSCRIPT = "skipped: transcript not persisted";

export function eligible(entry: QueueEntry, cfg: Config, now: Date): [boolean, string] {
  if (!fsx.exists(entry.transcript_path)) return [false, NO_TRANSCRIPT];

  let idleOk = entry.ended;
  if (!idleOk) {
    const mtime = fsx.mtimeMs(entry.transcript_path);
    if (mtime === null) return [false, NO_TRANSCRIPT];
    idleOk = (now.getTime() - mtime) / 60_000 >= cfg.worker.idle_minutes;
  }
  if (!idleOk) return [false, "not idle"];

  const toolUses = entry.tool_uses || countToolUses(entry.transcript_path);
  if (toolUses < cfg.worker.min_tool_uses) return [false, "below min_tool_uses"];
  return [true, "eligible"];
}

// --- run -----------------------------------------------------------------------

function isTransient(e: unknown): boolean {
  return e instanceof ProviderError || e instanceof ConfigError;
}

export async function runOnce(cfg?: Config, opts: RunOnceOptions = {}): Promise<RunSummary> {
  const config = cfg ?? loadConfig();
  const started = Date.now();
  const summary: RunSummary = { reflected: [], failed: [], skipped: [], curriculum: {}, duration_s: 0 };

  try {
    await withLock(async () => {
      writeHookSnapshot(config);
      const now = new Date();
      const worlds = config.worlds.filter((w) => opts.worldName === undefined || w.name === opts.worldName);
      const worldByName = new Map(config.worlds.map((w) => [w.name, w]));

      if (opts.reflect ?? true) {
        await reflectPending(config, worldByName, opts.worldName, now, opts.chat, summary);
      }

      reapStaleSessionDirs(now);
      pruneQueueBucket("done");
      pruneQueueBucket("failed");

      for (const world of worlds) {
        await runCurriculumIfDue(world, config, opts.curriculum ?? true, now, summary);
        try {
          rebuildScorecards(world, config);
        } catch (e) {
          log({ action: "feedback", world: world.name, result: `failed: ${(e as Error).message}` });
        }
        if (world.outline) {
          try {
            await exportNew(world, config);
          } catch (e) {
            log({ action: "outline", world: world.name, result: `failed: ${(e as Error).message}` });
          }
        }
      }

      summary.duration_s = Math.round(((Date.now() - started) / 1000) * 1000) / 1000;
      fsx.writeJson(join(paths.stateDir(), "worker-status.json"), { last_run: fsx.nowIso(), last_summary: summary });
    });
  } catch (e) {
    if (e instanceof LockHeld) return { reflected: [], failed: [], skipped: [], curriculum: {}, duration_s: 0, locked: true };
    throw e;
  }
  return summary;
}

async function reflectPending(
  cfg: Config,
  worldByName: Map<string, World>,
  worldName: string | undefined,
  now: Date,
  chat: ChatFn | undefined,
  summary: RunSummary,
): Promise<void> {
  for (const entry of listQueue("pending")) {
    if (worldName !== undefined && entry.world !== worldName) continue;
    const world = worldByName.get(entry.world);
    if (world === undefined) {
      const reason = `failed: unknown world ${JSON.stringify(entry.world)}`;
      moveToTerminal(entry, "failed", reason);
      summary.failed.push(entry.session_id);
      log({ action: "reflect", session_id: entry.session_id, result: reason });
      continue;
    }

    const [ok, reason] = eligible(entry, cfg, now);
    if (!ok) {
      if (reason.startsWith("failed")) {
        moveToTerminal(entry, "failed", reason);
        summary.failed.push(entry.session_id);
      } else if (reason.startsWith("skipped")) {
        // Nothing here will ever become reflectable, so the entry leaves the
        // queue instead of being re-read on every run.
        moveToTerminal(entry, "done", reason);
        summary.skipped.push(entry.session_id);
      } else {
        summary.skipped.push(entry.session_id);
      }
      log({ action: "reflect", session_id: entry.session_id, result: reason });
      continue;
    }

    try {
      const result = await reflectSession(entry, { cfg, world, chat });
      const outcome = result.recorded ? `recorded:${result.pattern}` : result.reason || "not recorded";
      moveToTerminal(entry, "done", outcome);
      summary.reflected.push(entry.session_id);
      log({ action: "reflect", session_id: entry.session_id, result: "done" });
    } catch (e) {
      const err = e as Error;
      const reason = `failed: ${err.constructor.name}: ${err.message}`.slice(0, 300);
      if (isTransient(e) && entry.attempts + 1 < MAX_ATTEMPTS) {
        // Provider down or model not configured yet: keep the session
        // queued so the next run retries once the operator fixes it.
        const updated = { ...entry, attempts: entry.attempts + 1, result: reason };
        writeEntry("pending", updated);
        summary.skipped.push(entry.session_id);
        log({ action: "reflect", session_id: entry.session_id, result: `retry later (${updated.attempts}/${MAX_ATTEMPTS}): ${reason}` });
        continue;
      }
      moveToTerminal(entry, "failed", reason);
      summary.failed.push(entry.session_id);
      log({ action: "reflect", session_id: entry.session_id, result: reason });
    }
  }
}

async function runCurriculumIfDue(world: World, cfg: Config, curriculumEnabled: boolean, now: Date, summary: RunSummary): Promise<void> {
  const marker = join(paths.stateDir(), `last-curriculum-${world.name}`);
  if (!curriculumEnabled || !curriculumDue(marker, cfg.worker.curriculum_interval_minutes, now)) return;
  try {
    const report = await curriculumRun(world, cfg, { apply: true });
    summary.curriculum[world.name] = report as unknown as Record<string, unknown>;
  } catch (e) {
    summary.curriculum[world.name] = { error: (e as Error).message };
  }
  fsx.ensureDir(dirname(marker));
  writeFileSync(marker, now.toISOString(), "utf8");
}

function curriculumDue(markerPath: string, intervalMinutes: number, now: Date): boolean {
  const mtime = fsx.mtimeMs(markerPath);
  if (mtime === null) return true;
  return (now.getTime() - mtime) / 60_000 >= intervalMinutes;
}

function log(payload: Record<string, unknown>): void {
  const line = { ts: fsx.nowIso(), ...payload };
  fsx.appendLine(paths.logFile("worker"), JSON.stringify(line));
}

export function status(): WorkerStatus {
  let lastRun: string | null = null;
  let lastSummary: RunSummary | null = null;
  const raw = fsx.readJsonOr<{ last_run?: string; last_summary?: RunSummary } | null>(join(paths.stateDir(), "worker-status.json"), null);
  if (raw) {
    lastRun = raw.last_run ?? null;
    lastSummary = raw.last_summary ?? null;
  }

  const lastCurriculum: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = readdirSync(paths.stateDir());
  } catch {
    // no state dir yet
  }
  for (const name of names) {
    if (!name.startsWith("last-curriculum-")) continue;
    const world = name.slice("last-curriculum-".length);
    const mtime = fsx.mtimeMs(join(paths.stateDir(), name));
    if (mtime !== null) lastCurriculum[world] = new Date(mtime).toISOString();
  }

  return {
    lock_held: Lock.held(),
    lock_pid: readPid(paths.workerLockFile()),
    pending: listQueue("pending").length,
    done: listQueue("done").length,
    failed: listQueue("failed").length,
    last_run: lastRun,
    last_summary: lastSummary,
    last_curriculum: lastCurriculum,
  };
}

export async function loop(cfg: Config, intervalS: number): Promise<never> {
  for (;;) {
    await runOnce(cfg);
    await sleep(intervalS * 1000);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
