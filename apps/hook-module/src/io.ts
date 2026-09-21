// Every call on the engine object lives here, spelled literally as
// `$.noun.method(...)`. The module loader refuses a `$` that is stored in a
// variable or reached indirectly, so `$` is only ever a parameter named `$`
// and it is never put in the session state.
//
// The engine rejects rather than returning a sentinel (a missing file, a
// directory that is not there, a command that cannot start). These wrappers
// turn each rejection into null or false, which is what the command hook path
// in apps/hook does with its try/catch around every readFileSync.

import type { EngineInterface, FsEntry, FsStat, ProcessRunInit, ProcessRunResult } from "claude-code";

export async function readText($: EngineInterface, path: string): Promise<string | null> {
  try {
    return await $.fs.read(path);
  } catch {
    return null;
  }
}

/** Whole-file write. The sandbox has no append, so every JSONL line goes
 * through the spool instead; this is for files the module owns outright
 * (start.json, an inbox lesson, a marker). */
export async function writeText($: EngineInterface, path: string, text: string): Promise<boolean> {
  try {
    await $.fs.write(path, text);
    return true;
  } catch {
    return false;
  }
}

export async function listDir($: EngineInterface, path: string): Promise<FsEntry[] | null> {
  try {
    return await $.fs.list(path);
  } catch {
    return null;
  }
}

export async function statPath($: EngineInterface, path: string): Promise<FsStat | null> {
  try {
    return await $.fs.stat(path);
  } catch {
    return null;
  }
}

export async function pathExists($: EngineInterface, path: string): Promise<boolean> {
  try {
    return await $.fs.exists(path);
  } catch {
    return false;
  }
}

// The engine logs every rejected call as an ERROR line in `claude --debug`
// output, so a missing file the module fully expects to be missing (no inbox
// yet, no worker lock, no marker dir) would read as five errors a session. The
// three wrappers below ask first, at 0.5 ms a call, and keep the try/catch of
// the plain form for the race between the two calls.

export async function readTextIfPresent($: EngineInterface, path: string): Promise<string | null> {
  if (!(await pathExists($, path))) return null;
  return readText($, path);
}

export async function listDirIfPresent($: EngineInterface, path: string): Promise<FsEntry[] | null> {
  if (!(await pathExists($, path))) return null;
  return listDir($, path);
}

export async function statPathIfPresent($: EngineInterface, path: string): Promise<FsStat | null> {
  if (!(await pathExists($, path))) return null;
  return statPath($, path);
}

export async function runCommand($: EngineInterface, argv: string[], init?: ProcessRunInit): Promise<ProcessRunResult | null> {
  try {
    return await $.process.run(argv, init);
  } catch {
    return null;
  }
}

export interface LayoutVars {
  vars: Record<string, string>;
  home: string;
}

/** The variables @sil/core/layout needs, read once per session. Each name is
 * spelled as a literal because `$.env.get` takes one: a loop over a list of
 * names is refused at load, and `claude plugin validate` lists exactly the
 * names that appear here. */
export async function readLayoutVars($: EngineInterface): Promise<LayoutVars> {
  const [silConfig, silState, silData, xdgConfig, xdgState, xdgData, home] = await Promise.all([
    $.env.get("SIL_CONFIG_DIR"),
    $.env.get("SIL_STATE_DIR"),
    $.env.get("SIL_DATA_DIR"),
    $.env.get("XDG_CONFIG_HOME"),
    $.env.get("XDG_STATE_HOME"),
    $.env.get("XDG_DATA_HOME"),
    $.env.get("HOME"),
  ]);
  const vars: Record<string, string> = {};
  if (silConfig) vars["SIL_CONFIG_DIR"] = silConfig;
  if (silState) vars["SIL_STATE_DIR"] = silState;
  if (silData) vars["SIL_DATA_DIR"] = silData;
  if (xdgConfig) vars["XDG_CONFIG_HOME"] = xdgConfig;
  if (xdgState) vars["XDG_STATE_HOME"] = xdgState;
  if (xdgData) vars["XDG_DATA_HOME"] = xdgData;
  if (home) vars["HOME"] = home;
  return { vars, home: home ?? "" };
}

/** `git rev-parse HEAD` in `cwd`, or null on any failure. Bounded to 1 s,
 * same as apps/hook/src/worlds.ts's gitHead. */
export async function gitHead($: EngineInterface, cwd: string): Promise<string | null> {
  const result = await runCommand($, ["git", "-C", cwd, "rev-parse", "HEAD"], { timeoutMs: 1000 });
  if (!result || result.exitCode !== 0) return null;
  const head = result.stdout.trim();
  return head || null;
}
