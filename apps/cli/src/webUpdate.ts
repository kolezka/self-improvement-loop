// Detects that the plugin this process runs from is no longer the current one.
//
// A `claude plugin install` writes a new versioned directory and repoints
// installed_plugins.json; a local `bun run build` rewrites dist/.srchash.
// Neither reaches a long lived `sil web`, which keeps serving the bundle it
// started with. The stamp below covers both, and `sil web` exits when it
// changes so systemd (Restart=always) or launchd (KeepAlive) starts the new
// version.

import { readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { paths } from "@sil/core";

const PLUGIN_NAME = "self-improvement-loop";

function readText(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

/** True when `root` sits inside the Claude plugin cache, so a marketplace
 * install governs which copy runs. A dev checkout does not, and must not
 * restart because some other plugin was updated. */
export function isInstalledCopy(root: string, claudeConfig: string = paths.claudeConfigDir()): boolean {
  const cache = join(claudeConfig, "plugins") + sep;
  return root.startsWith(cache);
}

/** installPath plus lastUpdated of the newest install of this plugin, "" when
 * the file is missing or names no install of it. Mirrors scripts/sil, which
 * picks the same entry. */
export function installedStamp(claudeConfig: string = paths.claudeConfigDir()): string {
  const raw = readText(join(claudeConfig, "plugins", "installed_plugins.json"));
  if (!raw) return "";
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return "";
  }
  const plugins = (data as { plugins?: Record<string, unknown> }).plugins ?? {};
  const entries = Object.keys(plugins)
    .filter((key) => key.split("@")[0] === PLUGIN_NAME)
    .flatMap((key) => (Array.isArray(plugins[key]) ? (plugins[key] as Array<Record<string, unknown>>) : []));
  if (entries.length === 0) return "";
  const newest = entries.reduce((a, b) => (String(a["lastUpdated"] ?? "") >= String(b["lastUpdated"] ?? "") ? a : b));
  return `${String(newest["installPath"] ?? "")}@${String(newest["lastUpdated"] ?? "")}`;
}

/** One string that changes whenever the code this process should run changes. */
export function updateStamp(root: string = paths.pluginRoot(), claudeConfig: string = paths.claudeConfigDir()): string {
  const build = readText(join(root, "dist", ".srchash"));
  const installed = isInstalledCopy(root, claudeConfig) ? installedStamp(claudeConfig) : "";
  return `${build}|${installed}`;
}

export interface WatchOptions {
  intervalMs?: number;
  root?: string;
  claudeConfig?: string;
}

/** Poll the stamp and call `onUpdate` once, the first time it differs from
 * the one taken now. Returns a stop function. */
export function watchForUpdates(onUpdate: () => void, opts: WatchOptions = {}): () => void {
  const root = opts.root ?? paths.pluginRoot();
  const claudeConfig = opts.claudeConfig ?? paths.claudeConfigDir();
  const baseline = updateStamp(root, claudeConfig);
  let fired = false;
  const timer = setInterval(() => {
    if (fired || updateStamp(root, claudeConfig) === baseline) return;
    fired = true;
    clearInterval(timer);
    onUpdate();
  }, opts.intervalMs ?? 5000);
  // A pending timer must not be the only reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}
