// Install the OpenClaw side of the integration: the plugin, the workspace
// skill, and the small config file that tells the plugin how to call sil.
//
// The plugin is copied, never symlinked, so an update to the sil checkout does
// not silently change what the gateway loads. Re-running install overwrites
// the copy.

import { copyFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fsx, paths } from "@sil/core";
import * as ocPaths from "./paths.ts";

/** Config the plugin reads at load time. */
export interface PluginConfigFile {
  sil: string;
  world: string;
  state_dir: string;
}

export const PLUGIN_CONFIG_FILE = "sil-config.json";

/** Source of the plugin and the skill inside the sil checkout or plugin root. */
export function sourceDir(): string {
  return join(paths.pluginRoot(), "integrations", "openclaw");
}

/** How the plugin should invoke sil: the shim from this checkout when it is
 * there, else whatever `sil` resolves to on PATH. */
export function silCommand(): string {
  const shim = join(paths.pluginRoot(), "scripts", "sil");
  return fsx.exists(shim) ? shim : "sil";
}

function copyDir(from: string, to: string): string[] {
  fsx.ensureDir(to);
  const written: string[] = [];
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    if (statSync(src).isDirectory()) {
      written.push(...copyDir(src, join(to, name)));
      continue;
    }
    const dest = join(to, name);
    copyFileSync(src, dest);
    written.push(dest);
  }
  return written;
}

export interface InstallOptions {
  world: string;
  workspace?: string;
  /** Also flip plugins.entries.<id>.enabled in openclaw.json. */
  enable?: boolean;
  env?: NodeJS.ProcessEnv;
}

export interface InstallResult {
  plugin_dir: string;
  skill_file: string;
  files: string[];
  enabled: boolean;
  config_file: string;
}

export function installIntegration(opts: InstallOptions): InstallResult {
  const env = opts.env ?? process.env;
  const src = sourceDir();
  if (!fsx.exists(src)) {
    throw new Error(`openclaw integration sources missing: ${src}`);
  }

  const pluginDir = ocPaths.pluginDir(env);
  const files = copyDir(join(src, "plugin"), pluginDir);

  const config: PluginConfigFile = {
    sil: silCommand(),
    world: opts.world,
    state_dir: paths.stateDir(),
  };
  const configPath = join(pluginDir, PLUGIN_CONFIG_FILE);
  fsx.writeJson(configPath, config);
  files.push(configPath);

  const workspace = opts.workspace ?? ocPaths.workspaceDir(env);
  const skillDir = ocPaths.skillDir(workspace);
  fsx.ensureDir(skillDir);
  const skillFile = join(skillDir, "SKILL.md");
  copyFileSync(join(src, "skill", "SKILL.md"), skillFile);
  files.push(skillFile);

  const enabled = opts.enable === true ? enablePlugin(env) : false;
  return { plugin_dir: pluginDir, skill_file: skillFile, files, enabled, config_file: ocPaths.configFile(env) };
}

/** Set `plugins.entries.<id>.enabled = true` in openclaw.json, keeping a copy
 * of the previous file next to it. The gateway needs a restart afterwards. */
export function enablePlugin(env: NodeJS.ProcessEnv = process.env): boolean {
  const path = ocPaths.configFile(env);
  if (!fsx.exists(path)) throw new Error(`openclaw config missing: ${path}`);

  const cfg = fsx.readJson<Record<string, unknown>>(path);
  const plugins = (cfg["plugins"] as Record<string, unknown> | undefined) ?? {};
  const entries = (plugins["entries"] as Record<string, unknown> | undefined) ?? {};
  const entry = (entries[ocPaths.PLUGIN_ID] as Record<string, unknown> | undefined) ?? {};
  if (entry["enabled"] === true) return false;

  fsx.atomicWrite(`${path}.sil-bak`, fsx.readText(path));
  entry["enabled"] = true;
  entries[ocPaths.PLUGIN_ID] = entry;
  plugins["entries"] = entries;
  cfg["plugins"] = plugins;
  fsx.writeJson(path, cfg);
  return true;
}

/** True when openclaw.json already enables the plugin. */
export function pluginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const cfg = fsx.readJsonOr<Record<string, unknown>>(ocPaths.configFile(env), {});
  const plugins = cfg["plugins"] as Record<string, unknown> | undefined;
  const entries = plugins?.["entries"] as Record<string, unknown> | undefined;
  const entry = entries?.[ocPaths.PLUGIN_ID] as Record<string, unknown> | undefined;
  return entry?.["enabled"] === true;
}
