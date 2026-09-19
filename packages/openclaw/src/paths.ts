// Where OpenClaw keeps its state on disk.
//
// Layout of a default install:
//   ~/.openclaw/openclaw.json                       gateway + plugin config
//   ~/.openclaw/workspace/                          bootstrap files and skills
//   ~/.openclaw/extensions/<id>/                    installed plugins
//   ~/.openclaw/agents/<agentId>/sessions/*.jsonl   session transcripts

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fsx } from "@sil/core";

export const PLUGIN_ID = "self-improvement-loop";
export const SKILL_NAME = "self-improvement-loop";

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/** `OPENCLAW_CONFIG_DIR`, else `$OPENCLAW_HOME/.openclaw`, else `~/.openclaw`. */
export function openclawDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_CONFIG_DIR;
  if (configured) return resolve(expandHome(configured));
  const home = env.OPENCLAW_HOME || homedir();
  return join(home, ".openclaw");
}

export function configFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(openclawDir(env), "openclaw.json");
}

export function agentsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(openclawDir(env), "agents");
}

export function extensionsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(openclawDir(env), "extensions");
}

export function pluginDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(extensionsDir(env), PLUGIN_ID);
}

/** The agent workspace: env override, else the path in openclaw.json, else
 * `<openclawDir>/workspace`. */
export function workspaceDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_WORKSPACE_DIR || env.OPENCLAW_WORKSPACE;
  if (configured) return resolve(expandHome(configured));

  const cfg = fsx.readJsonOr<Record<string, unknown>>(configFile(env), {});
  const agents = cfg["agents"] as Record<string, unknown> | undefined;
  const defaults = agents?.["defaults"] as Record<string, unknown> | undefined;
  const fromConfig = defaults?.["workspace"];
  if (typeof fromConfig === "string" && fromConfig) {
    const expanded = expandHome(fromConfig);
    return isAbsolute(expanded) ? expanded : resolve(openclawDir(env), expanded);
  }
  return join(openclawDir(env), "workspace");
}

export function skillDir(workspace: string): string {
  return join(workspace, "skills", SKILL_NAME);
}

/** True when this machine has an OpenClaw install to integrate with. */
export function installed(env: NodeJS.ProcessEnv = process.env): boolean {
  return fsx.exists(openclawDir(env));
}
