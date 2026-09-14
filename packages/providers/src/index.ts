// The single model transport. `chat` is the only way any engine code talks to
// a model. No base_url fallback, no placeholder key, no default model.

import { activeEndpoint, apiKey, endpointFor, loadLlm, ProviderError, ProviderTimeout, resolveRole, ROLES } from "@sil/core";
import type { Endpoint, LlmConfig, Role, World } from "@sil/core";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatOptions { world: World; llm?: LlmConfig; jsonMode?: boolean; maxTokens?: number }
export type ChatFn = (role: Role, messages: ChatMessage[], opts: ChatOptions) => Promise<string>;
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
/** Top level fields describe the endpoint that serves `critic`, so the CLI
 * status column and the web Overview keep reading one endpoint. `endpoints`
 * carries the whole picture. */
export interface ProviderStatus {
  endpoint: string | null;
  kind: string | null;
  base_url: string | null;
  models: Record<string, string | null>;
  reachable: boolean | null;
  error: string | null;
  endpoints: EndpointStatus[];
}

// spawnSync indirection for claude-cli: tests reassign `spawnSyncImpl.run`
// instead of patching the Bun global.
export interface SpawnSyncResult { success: boolean; exitCode: number; stdout: Buffer; stderr: Buffer; exitedDueToTimeout?: boolean }
export type SpawnSyncFn = (cmd: string[], opts: { stdin?: Buffer; timeout?: number }) => SpawnSyncResult;
export const spawnSyncImpl: { run: SpawnSyncFn } = {
  run: (cmd, opts) => Bun.spawnSync(cmd, { ...opts, stdout: "pipe", stderr: "pipe" }),
};

export const chat: ChatFn = async (role, messages, opts) => {
  const llm = opts.llm ?? loadLlm(opts.world);
  // Resolved per call, so the critic can sit on claude-cli while the drafter
  // and judge stay on LiteLLM. Enforces locality, raises on misconfig.
  const { endpoint, model } = resolveRole(llm, role, opts.world);
  if (endpoint.kind === "openai") return chatOpenai(endpoint, model, messages, { jsonMode: opts.jsonMode ?? false, maxTokens: opts.maxTokens ?? 4000 });
  if (endpoint.kind === "claude-cli") return chatClaudeCli(endpoint, model, messages, { maxTokens: opts.maxTokens ?? 4000 });
  throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has unknown kind ${JSON.stringify(endpoint.kind)}`);
};

/** Reachability and routing for every endpoint. Reports, never raises: a
 * broken llm.yaml or a dead proxy is a field in the answer, not an exception,
 * because `sil status` and the web Overview call this on every refresh. */
export async function status(world: World, llm?: LlmConfig): Promise<ProviderStatus> {
  const result: ProviderStatus = { endpoint: null, kind: null, base_url: null, models: {}, reachable: null, error: null, endpoints: [] };

  let llmCfg: LlmConfig;
  try {
    llmCfg = llm ?? loadLlm(world);
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }

  const servedBy = new Map<Role, string>();
  for (const role of ROLES) {
    try {
      servedBy.set(role, endpointFor(llmCfg, role).name);
    } catch {
      // role has no usable endpoint; result.error below names why
    }
    try {
      result.models[role] = resolveRole(llmCfg, role, world).model;
    } catch {
      result.models[role] = null;
    }
  }

  let activeName: string | null = null;
  try {
    activeName = activeEndpoint(llmCfg).name;
  } catch {
    // no active endpoint: every row reports active false
  }

  result.endpoints = await Promise.all(
    llmCfg.endpoints.map(async (ep): Promise<EndpointStatus> => {
      const probe = await probeEndpoint(ep);
      return {
        name: ep.name,
        kind: ep.kind,
        base_url: ep.base_url,
        active: ep.name === activeName,
        roles: ROLES.filter((r) => servedBy.get(r) === ep.name),
        models: { ...ep.models },
        reachable: probe.reachable,
        error: probe.error,
      };
    }),
  );

  const criticEndpoint = result.endpoints.find((e) => e.name === servedBy.get("critic")) ?? null;
  if (criticEndpoint) {
    result.endpoint = criticEndpoint.name;
    result.kind = criticEndpoint.kind;
    result.base_url = criticEndpoint.base_url;
    result.reachable = criticEndpoint.reachable;
    result.error = criticEndpoint.error;
  } else {
    try {
      endpointFor(llmCfg, "critic");
    } catch (e) {
      result.error = (e as Error).message;
    }
  }
  return result;
}

interface Probe { reachable: boolean | null; error: string | null }

async function probeEndpoint(endpoint: Endpoint): Promise<Probe> {
  if (endpoint.kind === "claude-cli") return probeClaudeCli();
  if (endpoint.kind !== "openai") return { reachable: null, error: `unknown endpoint kind ${JSON.stringify(endpoint.kind)}` };

  const base = (endpoint.base_url ?? "").replace(/\/+$/, "");
  if (!base) return { reachable: false, error: "no base_url configured" };
  let key: string | null;
  try {
    key = apiKey(endpoint);
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
  }
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const url = v1Url(base) + "/models";
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return { reachable: false, error: `HTTP ${resp.status}` };
    return { reachable: true, error: null };
  } catch (e) {
    const err = e as Error;
    return { reachable: false, error: `${err.name}: ${err.message}` };
  }
}

function probeClaudeCli(): Probe {
  try {
    const r = spawnSyncImpl.run(["claude", "--version"], { timeout: 5000 });
    if (r.exitedDueToTimeout) return { reachable: false, error: "claude --version timed out after 5s" };
    if (!r.success) return { reachable: false, error: `claude --version exited ${r.exitCode}: ${r.stderr.toString("utf8").slice(0, 200)}` };
    return { reachable: true, error: null };
  } catch (e) {
    return { reachable: false, error: `could not run claude --version: ${(e as Error).message}` };
  }
}

function v1Url(base: string): string {
  return base.endsWith("/v1") ? base : base + "/v1";
}

async function chatOpenai(
  endpoint: Endpoint,
  model: string,
  messages: ChatMessage[],
  opts: { jsonMode: boolean; maxTokens: number },
): Promise<string> {
  const base = (endpoint.base_url ?? "").replace(/\/+$/, "");
  if (!base) throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has no base_url configured`);
  const url = v1Url(base) + "/chat/completions";

  const body: Record<string, unknown> = { model, messages, temperature: 0, max_tokens: opts.maxTokens };
  if (opts.jsonMode) body["response_format"] = { type: "json_object" };
  // Operator knobs win over the defaults above (reasoning_effort, thinking, max_tokens).
  Object.assign(body, endpoint.extra_body ?? {});

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const key = apiKey(endpoint);
  if (key) headers["Authorization"] = `Bearer ${key}`;

  let resp: Response;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(endpoint.timeout_s * 1000),
    });
  } catch (e) {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      throw new ProviderTimeout(`provider ${JSON.stringify(endpoint.name)} at ${url} timed out after ${endpoint.timeout_s}s`);
    }
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} unreachable: ${err.message}`);
  }

  if (!resp.ok) {
    const detail = (await resp.text().catch(() => "")).slice(0, 300);
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} answered HTTP ${resp.status}: ${detail}`);
  }

  const raw = await resp.text();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} returned non-JSON (${raw.length} bytes): ${JSON.stringify(raw.slice(0, 300))}`);
  }

  const content = extractChoiceContent(data);
  if (content === null) throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} reply has no choices[0].message.content`);
  if (content.trim() === "") {
    // A reasoning model that spent the whole budget thinking returns an empty
    // content with finish_reason "length". Name that instead of letting the
    // caller report "no JSON object found".
    const meta = choiceMeta(data);
    throw new ProviderError(
      `provider ${JSON.stringify(endpoint.name)} model ${JSON.stringify(model)} returned empty content ` +
        `(finish_reason ${JSON.stringify(meta.finishReason)}, ${meta.reasoningTokens} reasoning tokens, ` +
        `${meta.completionTokens} completion tokens). Set extra_body on the endpoint in llm.yaml, ` +
        `for example { reasoning_effort: "low" } or { thinking: { type: "disabled" } }, or raise max_tokens there.`,
    );
  }
  return content;
}

function choiceMeta(data: unknown): { finishReason: string | null; reasoningTokens: number; completionTokens: number } {
  const d = (data ?? {}) as { choices?: Array<{ finish_reason?: unknown }>; usage?: { completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } } };
  const fr = d.choices?.[0]?.finish_reason;
  const num = (v: unknown) => (typeof v === "number" ? v : 0);
  return {
    finishReason: typeof fr === "string" ? fr : null,
    reasoningTokens: num(d.usage?.completion_tokens_details?.reasoning_tokens),
    completionTokens: num(d.usage?.completion_tokens),
  };
}

function extractChoiceContent(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const choices = (data as Record<string, unknown>)["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const first = choices[0];
  if (!first || typeof first !== "object") return null;
  const message = (first as Record<string, unknown>)["message"];
  if (!message || typeof message !== "object") return null;
  const content = (message as Record<string, unknown>)["content"];
  return typeof content === "string" ? content : null;
}

async function chatClaudeCli(endpoint: Endpoint, model: string, messages: ChatMessage[], _opts: { maxTokens: number }): Promise<string> {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const userParts = messages.filter((m) => m.role !== "system").map((m) => m.content);

  const cmd = ["claude", "-p", "--model", model, "--output-format", "json"];
  if (systemParts.length > 0) cmd.push("--append-system-prompt", systemParts.join("\n\n"));

  let result: SpawnSyncResult;
  try {
    result = spawnSyncImpl.run(cmd, { stdin: Buffer.from(userParts.join("\n\n"), "utf8"), timeout: endpoint.timeout_s * 1000 });
  } catch (e) {
    throw new ProviderError(`failed to run claude -p: ${(e as Error).message}`);
  }

  if (result.exitedDueToTimeout) {
    throw new ProviderTimeout(`claude -p timed out after ${endpoint.timeout_s}s`);
  }
  if (!result.success) {
    const stderrText = result.stderr.toString("utf8");
    const stdoutText = result.stdout.toString("utf8");
    throw new ProviderError(`claude -p exited ${result.exitCode}: ${(stderrText || stdoutText).slice(0, 300)}`);
  }

  const stdoutText = result.stdout.toString("utf8");
  let data: unknown;
  try {
    data = JSON.parse(stdoutText);
  } catch {
    throw new ProviderError(`claude -p returned non-JSON output: ${JSON.stringify(stdoutText.slice(0, 300))}`);
  }
  const obj = data && typeof data === "object" ? (data as Record<string, unknown>) : null;
  const resultField = obj ? obj["result"] : undefined;
  if (resultField === undefined || resultField === null) {
    throw new ProviderError(`claude -p reply has no 'result' field: ${JSON.stringify(String(data).slice(0, 300))}`);
  }
  return String(resultField);
}
