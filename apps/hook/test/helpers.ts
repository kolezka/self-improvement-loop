// Shared test scaffolding: an isolated SIL_CONFIG_DIR/SIL_STATE_DIR/
// SIL_DATA_DIR/CLAUDE_PLUGIN_ROOT per test, plus a helper to run the hook
// entry point (main.ts, or dist/hook.js once built) as a real subprocess the
// way Claude Code invokes it.

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
export const MAIN_TS = join(REPO_ROOT, "apps/hook/src/main.ts");
export const HOOK_JS = join(REPO_ROOT, "dist/hook.js");

export interface HookEnv {
  root: string;
  config: string;
  state: string;
  data: string;
  pluginRoot: string;
  env: Record<string, string>;
}

/** A fresh temp dir tree plus the env vars that point every @sil/core path
 * helper at it. `pluginRoot` defaults to the real repo so builtin nudges
 * (packages/nudges' fallback dir) resolve; override when a test needs a
 * synthetic plugin root instead. */
export function makeHookEnv(pluginRoot: string = REPO_ROOT): HookEnv {
  const root = mkdtempSync(join(tmpdir(), "sil-hook-test-"));
  const config = join(root, "config");
  const state = join(root, "state");
  const data = join(root, "data");
  mkdirSync(config, { recursive: true });
  mkdirSync(state, { recursive: true });
  mkdirSync(data, { recursive: true });
  return {
    root,
    config,
    state,
    data,
    pluginRoot,
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: root,
      SIL_CONFIG_DIR: config,
      SIL_STATE_DIR: state,
      SIL_DATA_DIR: data,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
    },
  };
}

export function cleanupHookEnv(hookEnv: HookEnv): void {
  rmSync(hookEnv.root, { recursive: true, force: true });
}

export interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

/** Run `entry` (main.ts, or a built dist/hook.js) as a real bun subprocess
 * with `payload` on stdin, mirroring exactly how Claude Code invokes the
 * hook. `extraEnv` merges over (and can override) the base hookEnv.env. */
export function runHook(entry: string, hookEnv: HookEnv, payload: unknown, extraEnv: Record<string, string> = {}): RunResult {
  const stdin = payload === undefined ? "" : typeof payload === "string" ? payload : JSON.stringify(payload);
  const proc = Bun.spawnSync(["bun", entry], {
    stdin: Buffer.from(stdin, "utf8"),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...hookEnv.env, ...extraEnv },
  });
  return {
    exitCode: proc.exitCode,
    stdout: (proc.stdout ?? Buffer.alloc(0)).toString("utf8"),
    stderr: (proc.stderr ?? Buffer.alloc(0)).toString("utf8"),
  };
}

/** Every entry point this project ships for the hook: the source (always
 * present) and the built bundle (only once `bun run build` has run). Tests
 * that must pass against both loop over this list. */
export function hookEntries(): string[] {
  const entries = [MAIN_TS];
  if (existsSync(HOOK_JS)) entries.push(HOOK_JS);
  return entries;
}
