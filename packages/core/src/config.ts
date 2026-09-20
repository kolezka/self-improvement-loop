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

function parseYamlFile(path: string): unknown {
  try {
    return YAML.parse(readText(path)) ?? {};
  } catch (e) {
    // A broken config file is an operator problem, not a crash: callers map
    // ConfigError to a retry or a 503, a raw YAMLParseError to a hard failure.
    throw new ConfigError(`invalid ${path}: ${(e as Error).message.split("\n")[0]}`);
  }
}

export function loadConfig(path: string = paths.configFile()): Config {
  if (!exists(path)) return Config.parse({});
  const raw = parseYamlFile(path);
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
  const raw = parseYamlFile(p);
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

function requireRole(role: Role): void {
  if (!(ROLES as readonly string[]).includes(role)) throw new ConfigError(`unknown model role ${role}; roles are ${ROLES.join(", ")}`);
}

/** The endpoint that serves a role: `role_endpoints[role]`, else `active`,
 * else the first endpoint. An endpoint name that is not defined is an
 * operator mistake, never a silent fall through to another endpoint. */
export function endpointFor(llm: LlmConfig, role: Role): Endpoint {
  requireRole(role);
  if (llm.endpoints.length === 0) throw new ModelNotConfigured("llm.yaml has no endpoints; run `sil init` or edit it");
  const override = llm.role_endpoints[role];
  const name = override ?? llm.active ?? llm.endpoints[0]!.name;
  const e = llm.endpoints.find((x) => x.name === name);
  if (!e) {
    const where = override ? `role_endpoints.${role}` : "active";
    throw new ModelNotConfigured(`llm.yaml ${where} endpoint ${JSON.stringify(name)} is not defined`);
  }
  return e;
}

export interface ResolvedRole {
  endpoint: Endpoint;
  model: string;
}

/** Endpoint plus model name for a role. The endpoint's own `models` wins; the
 * top level `models` map is the fallback so a pre-switching llm.yaml keeps
 * working. Never defaults. Enforces locality. */
export function resolveRole(llm: LlmConfig, role: Role, world?: World | null): ResolvedRole {
  requireRole(role);
  const endpoint = endpointFor(llm, role);
  const model = endpoint.models[role] ?? llm.models[role];
  if (!model) {
    throw new ModelNotConfigured(
      `no model for role ${role} on endpoint ${endpoint.name}; ` +
        `set endpoints[${endpoint.name}].models.${role} in llm.yaml or run sil llm set-model`,
    );
  }
  if (world && world.llm === "local" && !llm.local_models.includes(model)) {
    throw new LocalityViolation(`world ${world.name} is llm: local but models.${role}=${model} is not in local_models`);
  }
  return { endpoint, model };
}

/** The model name for a role. Never defaults. Enforces locality. */
export function modelFor(llm: LlmConfig, role: Role, world?: World | null): string {
  return resolveRole(llm, role, world).model;
}

/** A `system-one` endpoint answers typed decisions, never text, so the critic
 * and the drafter cannot run on one. Refused here rather than at the first
 * curriculum run, where the cost is a whole pattern gated out. */
function assertServes(endpoint: Endpoint, role: Role | undefined): void {
  if (endpoint.kind !== "system-one" || role === "judge") return;
  const what = role === undefined ? "every role" : `role ${role}`;
  throw new ConfigError(
    `endpoint ${JSON.stringify(endpoint.name)} is kind system-one and cannot serve ${what}; ` +
      `it answers a typed decision, not text. Route the judge to it instead: ` +
      `sil llm use ${endpoint.name} --role judge`,
  );
}

/** Point `active` at an endpoint, or route a single role to it. Switching
 * every role clears the per role overrides: a full switch, not a half one. */
export function useEndpoint(llm: LlmConfig, name: string, role?: Role): LlmConfig {
  const endpoint = llm.endpoints.find((e) => e.name === name);
  if (!endpoint) {
    const known = llm.endpoints.map((e) => e.name).join(", ") || "none";
    throw new ConfigError(`unknown endpoint ${JSON.stringify(name)}; llm.yaml defines ${known}`);
  }
  if (role !== undefined) requireRole(role);
  assertServes(endpoint, role);
  if (role === undefined) return { ...llm, active: name, role_endpoints: {} };
  return { ...llm, role_endpoints: { ...llm.role_endpoints, [role]: name } };
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
