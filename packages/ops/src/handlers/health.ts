import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, paths } from "@sil/core";
import type { NoArgs } from "../args.ts";
import { deps } from "../deps.ts";

const SIL_VERSION = "0.3.2";

/** Which build is on disk now, and whether the running server predates it.
 *
 * A plugin update rewrites dist/ under a server that is already running and a
 * browser that already holds the old JS. The two need different answers: a new
 * `build` is fixed by reloading the page, because static files are read from
 * disk per request, while `server_stale` is not, because the process is still
 * executing the bundle it started with.
 *
 * Both come from disk and the clock on every call. Snapshotting the hash at
 * import time would report the build of whatever loaded this module first,
 * which for the CLI is a different process than the one being asked about. */
export function buildInfo(_args: NoArgs): Record<string, unknown> {
  const path = join(paths.pluginRoot(), "dist", ".srchash");
  let build: string | null = null;
  let builtAt: string | null = null;
  try {
    build = readFileSync(path, "utf8").trim() || null;
    builtAt = statSync(path).mtime.toISOString();
  } catch {
    // No dist/: a dev run straight from source. null is what stops the UI
    // announcing an update it cannot see.
  }
  const startedMs = Date.now() - process.uptime() * 1000;
  return {
    build,
    built_at: builtAt,
    server_started: new Date(startedMs).toISOString(),
    server_stale: builtAt !== null && Date.parse(builtAt) > startedMs,
    plugin_root: paths.pluginRoot(),
    version: SIL_VERSION,
  };
}

export async function healthReport(_args: NoArgs): Promise<Record<string, unknown>> {
  const cfg = loadConfig();

  const providersStatus: Record<string, unknown> = {};
  for (const w of cfg.worlds) {
    try {
      providersStatus[w.name] = await deps.providers.status(w);
    } catch (e) {
      const err = e as Error;
      providersStatus[w.name] = { error: `${err.name}: ${err.message}` };
    }
  }

  let workerStatus: unknown;
  try {
    workerStatus = deps.worker.status();
  } catch (e) {
    const err = e as Error;
    workerStatus = { error: `${err.name}: ${err.message}` };
  }

  return {
    worlds: cfg.worlds.map((w) => w.name),
    config_file: paths.configFile(),
    llm_file: paths.llmFile(),
    state_dir: paths.stateDir(),
    data_dir: paths.dataDir(),
    plugin_root: paths.pluginRoot(),
    providers: providersStatus,
    worker: workerStatus,
    versions: { sil: SIL_VERSION },
  };
}
