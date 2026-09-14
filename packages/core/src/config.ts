// Load and save config.yaml and llm.yaml. Resolve worlds and model roles.

import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { ROLES, type Role } from "./consts.ts";
import { ConfigError, LocalityViolation, ModelNotConfigured } from "./errors.ts";
import { atomicWrite, exists, readText, writeJson } from "./fsx.ts";
import * as paths from "./paths.ts";
import { Config, type Endpoint, type HookSnapshot, LlmConfig, type World } from "./schemas.ts";

// --- config.yaml --------------------------------------------------------

export function loadConfig(path: string = paths.configFile()): Config {
  if (!exists(path)) return Config.parse({});
  const raw = YAML.parse(readText(path)) ?? {};
  const parsed = Config.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`invalid ${path}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function saveConfig(cfg: Config, path: string = paths.configFile()): string {
  atomicWrite(path, YAML.stringify(Config.parse(cfg)));
  return path;
}

export function worldNamed(cfg: Config, name: string): World {
  const w = cfg.worlds.find((x) => x.name === name);
  if (!w) throw new ConfigError(`unknown world: ${JSON.stringify(name)}`);
  return w;
}

function realOrResolve(p: string): string {
  const abs = resolve(paths.expandHome(p));
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Longest `repos` prefix match; the first world with empty repos is the
 * catch-all. Throws when nothing matches and no catch-all exists. */
export function worldForCwd(cfg: Config, cwd: string): World {
  const target = realOrResolve(cwd);
  let best: { score: number; world: World } | null = null;
  let fallback: World | null = null;
  for (const w of cfg.worlds) {
    if (w.repos.length === 0 && fallback === null) fallback = w;
    for (const repo of w.repos) {
      const r = realOrResolve(repo);
      if (isWithin(target, r)) {
        const score = r.split("/").length;
        if (!best || score > best.score) best = { score, world: w };
      }
    }
  }
  if (best) return best.world;
  if (fallback) return fallback;
  throw new ConfigError(`no world owns ${target} and no catch-all world exists`);
}

export function targetRoot(world: World): string {
  return paths.expandHome(world.target ?? paths.defaultTarget(world.name));
}

export function ledgerPath(world: World): string {
  return join(targetRoot(world), world.layout.ledger);
}

export function isBuiltinTarget(world: World): boolean {
  return world.target === null;
}

// --- llm.yaml -----------------------------------------------------------

export function loadLlm(world?: World | null, path?: string): LlmConfig {
  const p = paths.expandHome(path ?? world?.llm_config ?? paths.llmFile());
  if (!exists(p)) return LlmConfig.parse({});
  const raw = YAML.parse(readText(p)) ?? {};
  const parsed = LlmConfig.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`invalid ${p}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  return parsed.data;
}

export function saveLlm(llm: LlmConfig, path: string = paths.llmFile()): string {
  atomicWrite(path, YAML.stringify(LlmConfig.parse(llm)));
  return path;
}

export function activeEndpoint(llm: LlmConfig): Endpoint {
  if (llm.endpoints.length === 0) throw new ModelNotConfigured("llm.yaml has no endpoints; run `sil init` or edit it");
  const name = llm.active ?? llm.endpoints[0]!.name;
  const e = llm.endpoints.find((x) => x.name === name);
  if (!e) throw new ModelNotConfigured(`llm.yaml active endpoint ${JSON.stringify(name)} is not defined`);
  return e;
}

/** The model name for a role. Never defaults. Enforces locality. */
export function modelFor(llm: LlmConfig, role: Role, world?: World | null): string {
  if (!(ROLES as readonly string[]).includes(role)) throw new ConfigError(`unknown model role ${role}; roles are ${ROLES.join(", ")}`);
  const model = llm.models[role];
  if (!model) throw new ModelNotConfigured(`llm.yaml models.${role} is not set`);
  if (world && world.llm === "local" && !llm.local_models.includes(model)) {
    throw new LocalityViolation(`world ${world.name} is llm: local but models.${role}=${model} is not in local_models`);
  }
  return model;
}

/** The credential for an endpoint, or null when it needs none. Throws when a
 * declared env var is unset: no placeholder keys. */
export function apiKey(endpoint: Endpoint): string | null {
  if (endpoint.kind === "claude-cli") return null;
  if (!endpoint.api_key_env) return null;
  const value = process.env[endpoint.api_key_env];
  if (!value) throw new ModelNotConfigured(`env var ${endpoint.api_key_env} (api_key_env) is not set`);
  return value;
}

// --- hook snapshot ------------------------------------------------------

/** Plain JSON view of config for the hook fast path. Called by every engine
 * entry point so the hook never reads a stale world map for long. */
export function writeHookSnapshot(cfg: Config = loadConfig()): string {
  const snap: HookSnapshot = {
    version: 1,
    worlds: cfg.worlds.map((w) => {
      const root = targetRoot(w);
      return {
        name: w.name,
        repos: w.repos.map((r) => realOrResolve(r)),
        nudges_dir: join(root, w.layout.nudges_dir),
        rules_file: join(root, w.layout.rules_file),
        rules_inject: w.rules_inject,
      };
    }),
    worker: cfg.worker,
    plugin_root: paths.pluginRoot(),
  };
  const p = paths.hookSnapshotFile();
  writeJson(p, snap);
  return p;
}
