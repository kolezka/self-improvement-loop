// Worker kick, ported from apps/hook/src/kick.ts. Same five gates in the same
// order: the snapshot exists, auto_kick is on, no live worker holds the lock,
// the last kick is older than the throttle, and there is work to do.
//
// The sandbox has no spawn of its own, so the detach is a shell: `$.process.run`
// waits for the child to exit and `nohup ... &` exits at once, leaving the
// worker running with its own stdio.

import { DEFAULT_WORKER, defaultWorldFor } from "@sil/core/hook-snapshot";
import type { WorkerConfig } from "@sil/core/hook-snapshot";
import type { EngineInterface } from "claude-code";
import { listDirIfPresent, pathExists, readTextIfPresent, runCommand, statPathIfPresent, writeText } from "./io.ts";
import type { SessionState } from "./state.ts";

const WORKER_KICK_THROTTLE_MS = 15 * 60 * 1000;

/** A path as one shell word. Everything the kick interpolates comes from the
 * config snapshot or the plugin root, so it can carry a quote. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** The worker lock file is truncated on a clean exit but never unlinked, so its
 * existence says nothing. Read the pid it names and probe that process. */
async function workerRunning($: EngineInterface, state: SessionState): Promise<boolean> {
  const text = await readTextIfPresent($, state.layout.workerLockFile());
  if (text === null) return false;
  const pid = Number.parseInt(text.trim(), 10);
  if (!Number.isFinite(pid)) return false;
  const result = await runCommand($, ["kill", "-0", String(pid)]);
  if (!result) return false;
  if (result.exitCode === 0) return true;
  // "Operation not permitted": the process exists and belongs to someone else.
  return result.stderr.toLowerCase().includes("permitted");
}

/** True if any world's curriculum marker is missing or older than the interval.
 * One kick runs the worker once for every world, so any single world being due
 * is reason enough. */
async function curriculumDueForAnyWorld($: EngineInterface, state: SessionState, intervalMinutes: number): Promise<boolean> {
  const intervalS = Number.isFinite(intervalMinutes)
    ? Math.max(intervalMinutes, 0) * 60
    : DEFAULT_WORKER.curriculum_interval_minutes * 60;
  const worlds = state.snapshot.worlds?.length ? state.snapshot.worlds : [defaultWorldFor(state.layout.defaultTarget("default"))];
  const stateDir = state.layout.stateDir();
  for (const world of worlds) {
    if (!world || typeof world !== "object") continue;
    const marker = `${stateDir}/last-curriculum-${world.name || "default"}`;
    const st = await statPathIfPresent($, marker);
    if (!st) return true;
    if (Date.now() / 1000 - st.mtimeMs / 1000 >= intervalS) return true;
  }
  return false;
}

async function hasPendingWork($: EngineInterface, state: SessionState, workerCfg: WorkerConfig): Promise<boolean> {
  // A missing queue dir lists as null: nothing pending, not an error.
  const pending = await listDirIfPresent($, state.layout.queueDir("pending"));
  if (pending && pending.length > 0) return true;
  const interval = workerCfg.curriculum_interval_minutes ?? DEFAULT_WORKER.curriculum_interval_minutes;
  return curriculumDueForAnyWorld($, state, interval);
}

export async function maybeKickWorker($: EngineInterface, state: SessionState): Promise<void> {
  if (!state.snapshotPresent) return; // never `sil init`ed: nothing to kick
  const workerCfg = state.snapshot.worker ?? DEFAULT_WORKER;
  if (workerCfg.auto_kick === false) return;
  if (await workerRunning($, state)) return;

  const lastKick = `${state.layout.stateDir()}/last-kick`;
  const st = await statPathIfPresent($, lastKick);
  if (st && Date.now() - st.mtimeMs < WORKER_KICK_THROTTLE_MS) return;

  if (!(await hasPendingWork($, state, workerCfg))) return;

  // Claim the throttle before the spawn, so two sessions starting together do
  // not both kick. A write that fails is a state dir we cannot use at all.
  if (!(await writeText($, lastKick, ""))) return;

  const logPath = state.layout.logFile("worker");
  // `>>` cannot create the logs directory. An empty write can, and it only runs
  // when the log is not there yet, so it never truncates a real log.
  if (!(await pathExists($, logPath))) await writeText($, logPath, "");

  const built = `${state.pluginRoot}/dist/cli.js`;
  const bunCmd = (await pathExists($, built))
    ? `bun ${shellQuote(built)} worker --once`
    : `bun run ${shellQuote(`${state.pluginRoot}/apps/cli/src/main.ts`)} worker --once`;
  await runCommand($, ["sh", "-c", `nohup ${bunCmd} >> ${shellQuote(logPath)} 2>&1 </dev/null &`], { cwd: state.pluginRoot });
}
