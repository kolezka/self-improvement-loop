// sil openclaw: run the loop against an OpenClaw install.
//
// install  copy the plugin and the skill into ~/.openclaw
// sync     write rules and pending lessons into the workspace bootstrap file
// scan     queue OpenClaw session transcripts for reflection
// enqueue  queue one session, normally called by the plugin at session_end
// status   what is installed and what is queued

import { existsSync } from "node:fs";
import { join } from "node:path";
import { ConfigError, loadConfig, ValidationError } from "@sil/core";
import {
  enqueueSession,
  findSession,
  installIntegration,
  listSessions,
  paths as ocPaths,
  pluginEnabled,
  scanSessions,
  syncWorkspace,
  type EnqueueResult,
} from "@sil/openclaw";
import { loadEntry } from "@sil/store";
import { resolveWorld } from "../common.ts";

function requireOpenclaw(): void {
  if (!ocPaths.installed()) {
    throw new ConfigError(`no OpenClaw install at ${ocPaths.openclawDir()}. Set OPENCLAW_CONFIG_DIR when it lives elsewhere`);
  }
}

function printResults(results: EnqueueResult[], json: boolean | undefined): void {
  if (json === true) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  for (const r of results) console.log(`${r.status.padEnd(7)} ${r.session_id}  world=${r.world}  ${r.reason}`);
  if (results.length === 0) console.log("no OpenClaw sessions found");
}

export interface InstallOptions {
  world?: string;
  workspace?: string;
  enable?: boolean;
}

export function cmdOpenclawInstall(opts: InstallOptions): number {
  requireOpenclaw();
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const result = installIntegration({ world: world.name, workspace: opts.workspace, enable: opts.enable === true });

  console.log(`plugin  ${result.plugin_dir}`);
  console.log(`skill   ${result.skill_file}`);
  console.log(`world   ${world.name}`);
  if (opts.enable === true) {
    console.log(result.enabled ? `enabled in ${result.config_file} (backup at ${result.config_file}.sil-bak)` : "already enabled");
    console.log("restart the OpenClaw gateway to load the plugin");
  } else {
    console.log(`not enabled yet. Run: openclaw plugins enable ${ocPaths.PLUGIN_ID}`);
  }
  return 0;
}

export interface SyncOptions {
  world?: string;
  workspace?: string;
  file?: string;
  limit?: number;
  dryRun?: boolean;
}

export function cmdOpenclawSync(opts: SyncOptions): number {
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const workspace = opts.workspace ?? ocPaths.workspaceDir();
  const result = syncWorkspace(world, { workspace, file: opts.file, limit: opts.limit, dryRun: opts.dryRun === true });

  if (opts.dryRun === true) {
    console.log(result.block);
    console.log(`would write ${result.path}`);
    return 0;
  }
  console.log(`${result.path}: rules=${result.rules ? "yes" : "no"} lessons=${result.lessons.length}`);
  return 0;
}

export interface ScanOptions {
  world?: string;
  maxAgeHours?: number;
  json?: boolean;
}

export function cmdOpenclawScan(opts: ScanOptions): number {
  requireOpenclaw();
  const cfg = loadConfig();
  // No --world: each session goes to the world that owns its own cwd, not the
  // cwd of this process.
  printResults(scanSessions(cfg, { world: opts.world, maxAgeHours: opts.maxAgeHours }), opts.json);
  return 0;
}

export interface EnqueueOptions {
  session?: string;
  agent?: string;
  ended?: boolean;
  world?: string;
  json?: boolean;
}

export function cmdOpenclawEnqueue(opts: EnqueueOptions): number {
  requireOpenclaw();
  if (!opts.session) throw new ValidationError("--session <id> is required");
  const cfg = loadConfig();
  const session = findSession(opts.session, opts.agent);
  if (!session) {
    console.error(`error: no OpenClaw transcript for session ${opts.session}`);
    return 1;
  }
  printResults([enqueueSession(cfg, session, { ended: opts.ended === true, world: opts.world })], opts.json);
  return 0;
}

export interface StatusOptions {
  json?: boolean;
}

export function cmdOpenclawStatus(opts: StatusOptions): number {
  const installed = ocPaths.installed();
  const workspace = installed ? ocPaths.workspaceDir() : null;
  const sessions = installed ? listSessions() : [];

  const status = {
    openclaw_dir: ocPaths.openclawDir(),
    installed,
    workspace,
    plugin_dir: ocPaths.pluginDir(),
    plugin_installed: existsSync(join(ocPaths.pluginDir(), "openclaw.plugin.json")),
    plugin_enabled: installed ? pluginEnabled() : false,
    skill_installed: workspace ? existsSync(join(ocPaths.skillDir(workspace), "SKILL.md")) : false,
    sessions: sessions.length,
    queued: sessions.filter((s) => loadEntry("pending", s.session_id) !== null).length,
  };

  if (opts.json === true) {
    console.log(JSON.stringify(status, null, 2));
    return 0;
  }
  console.log(`openclaw dir     ${status.openclaw_dir}${status.installed ? "" : " (missing)"}`);
  console.log(`workspace        ${status.workspace ?? "-"}`);
  console.log(`plugin           ${status.plugin_installed ? "installed" : "not installed"}, ${status.plugin_enabled ? "enabled" : "not enabled"}`);
  console.log(`skill            ${status.skill_installed ? "installed" : "not installed"}`);
  console.log(`sessions         ${status.sessions} (${status.queued} pending in queue)`);
  return 0;
}
