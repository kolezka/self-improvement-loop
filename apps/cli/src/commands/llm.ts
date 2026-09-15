// sil llm: show which endpoint serves which role, switch provider, and set
// the model an endpoint uses for a role.
//
// Model names are per endpoint, so switching provider never rewrites them:
// LiteLLM wants zai/glm-5.3-flash where claude-cli wants sonnet.

import { ConfigError, endpointFor, loadConfig, loadLlm, resolveRole, ROLES, saveLlm, useEndpoint, writeHookSnapshot } from "@sil/core";
import type { LlmConfig, Role } from "@sil/core";
import { resolveWorld } from "../common.ts";
import { defaultDeps, type Deps } from "../deps.ts";

export interface LlmListOptions {
  json?: boolean;
  world?: string;
}
export interface LlmUseOptions {
  role?: string;
}
export interface LlmSetModelOptions {
  endpoint?: string;
}

interface RoleRow {
  role: Role;
  endpoint: string | null;
  model: string | null;
  error: string | null;
}

function requireRole(value: string): Role {
  if ((ROLES as readonly string[]).includes(value)) return value as Role;
  throw new ConfigError(`unknown role ${JSON.stringify(value)}; roles are ${ROLES.join(", ")}`);
}

function roleRows(llm: LlmConfig): RoleRow[] {
  return ROLES.map((role) => {
    try {
      const resolved = resolveRole(llm, role);
      return { role, endpoint: resolved.endpoint.name, model: resolved.model, error: null };
    } catch (e) {
      let endpoint: string | null = null;
      try {
        endpoint = endpointFor(llm, role).name;
      } catch {
        // no endpoint serves this role either; the error line says why
      }
      return { role, endpoint, model: null, error: (e as Error).message };
    }
  });
}

function printRoles(llm: LlmConfig): void {
  for (const row of roleRows(llm)) {
    const target = row.error ? row.error : `${row.endpoint}: ${row.model}`;
    console.log(`${row.role.padEnd(7)} -> ${target}`);
  }
}

/** claude-cli endpoints have no base_url; say what they do call instead. */
function addressOf(kind: string, baseUrl: string | null): string {
  if (kind === "claude-cli") return "claude -p";
  return baseUrl ?? "(no base_url)";
}

export async function cmdLlmList(opts: LlmListOptions, deps: Deps = defaultDeps): Promise<number> {
  const llm = loadLlm();
  const cfg = loadConfig();
  const world = resolveWorld(cfg, opts.world);
  const status = await deps.providers.status(world, llm);
  const rows = roleRows(llm);

  if (opts.json) {
    console.log(JSON.stringify({ active: llm.active, endpoints: status.endpoints, roles: rows }, null, 2));
    return 0;
  }

  console.log(`${"endpoint".padEnd(18)} ${"kind".padEnd(11)} ${"address".padEnd(30)} reachable`);
  for (const ep of status.endpoints) {
    const name = ep.active ? `${ep.name} *` : ep.name;
    const reach = ep.error ? `${ep.reachable} (${ep.error})` : String(ep.reachable);
    console.log(`${name.padEnd(18)} ${ep.kind.padEnd(11)} ${addressOf(ep.kind, ep.base_url).padEnd(30)} ${reach}`);
  }
  if (status.endpoints.length === 0) console.log("(llm.yaml defines no endpoints; run `sil init`)");
  console.log();
  for (const row of rows) {
    console.log(`${row.role.padEnd(7)} -> ${row.error ? row.error : `${row.endpoint}: ${row.model}`}`);
  }
  return 0;
}

export function cmdLlmUse(name: string, opts: LlmUseOptions): number {
  const role = opts.role === undefined ? undefined : requireRole(opts.role);
  const llm = useEndpoint(loadLlm(), name, role);
  saveLlm(llm);
  writeHookSnapshot();
  if (role) console.log(`role_endpoints.${role} = ${name}`);
  else console.log(`active = ${name} (per role overrides cleared)`);
  printRoles(llm);
  return 0;
}

export function cmdLlmSetModel(roleArg: string, model: string, opts: LlmSetModelOptions): number {
  const role = requireRole(roleArg);
  const llm = loadLlm();
  // Default to whichever endpoint currently serves the role, so the common
  // case needs no --endpoint.
  const name = opts.endpoint ?? endpointFor(llm, role).name;
  const endpoint = llm.endpoints.find((e) => e.name === name);
  if (!endpoint) {
    const known = llm.endpoints.map((e) => e.name).join(", ") || "none";
    throw new ConfigError(`unknown endpoint ${JSON.stringify(name)}; llm.yaml defines ${known}`);
  }
  endpoint.models = { ...endpoint.models, [role]: model };
  saveLlm(llm);
  console.log(`endpoints[${name}].models.${role} = ${model}`);
  return 0;
}
