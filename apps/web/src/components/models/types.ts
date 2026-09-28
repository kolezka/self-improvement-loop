// Shared types and small helpers for the Models pane, its role cards and its
// endpoint rows. llm.get and llm.status never carry a secret value, only the
// name of the environment variable that holds one: keep it that way here.

export type Role = "critic" | "drafter" | "judge";
export const ROLES: Role[] = ["critic", "drafter", "judge"];
export const ROLE_LABEL: Record<Role, string> = { critic: "Critic", drafter: "Drafter", judge: "Judge" };

export interface EndpointCfg {
  name: string;
  kind: string;
  base_url: string | null;
  api_key_env: string | null;
  timeout_s: number;
  models: Partial<Record<Role, string>>;
  extra_body: Record<string, unknown>;
}

export interface LlmCfg {
  endpoints: EndpointCfg[];
  active: string | null;
  role_endpoints: Partial<Record<Role, string>>;
  local_models: string[];
  models: Partial<Record<Role, string>>;
}

export interface EndpointStatus {
  name: string;
  kind: string;
  base_url: string | null;
  active: boolean;
  roles: Role[];
  models: Partial<Record<Role, string>>;
  reachable: boolean | null;
  error: string | null;
}

export interface ProviderStatus {
  endpoint: string | null;
  models: Record<string, string | null>;
  endpoints: EndpointStatus[];
  error: string | null;
}

/** One reachability reading rendered three ways: dot, text colour, wording. */
export interface Reach {
  dot: string;
  tone: string;
  text: string;
}

export function reachOf(reachable: boolean | null): Reach {
  if (reachable === null) return { dot: "warn", tone: "warn-text", text: "Unknown" };
  if (reachable) return { dot: "ok", tone: "ok-text", text: "Reachable" };
  return { dot: "err", tone: "error-text", text: "Unreachable" };
}

export function addressOf(ep: { kind: string; base_url: string | null }): string {
  return ep.kind === "claude-cli" ? "claude -p" : (ep.base_url ?? "no base_url set");
}
