// The single model transport. `chat` is the only way any engine code talks to
// a model. No base_url fallback, no placeholder key, no default model.

import { activeEndpoint, apiKey, ConfigError, loadLlm, modelFor, ProviderError, ProviderTimeout, ROLES } from "@sil/core";
import type { Endpoint, LlmConfig, Role, World } from "@sil/core";

export interface ChatMessage { role: "system" | "user" | "assistant"; content: string }
export interface ChatOptions { world: World; llm?: LlmConfig; jsonMode?: boolean; maxTokens?: number }
export type ChatFn = (role: Role, messages: ChatMessage[], opts: ChatOptions) => Promise<string>;
export interface ProviderStatus { endpoint: string | null; kind: string | null; base_url: string | null; models: Record<string, string | null>; reachable: boolean | null; error: string | null }

// spawnSync indirection for claude-cli: tests reassign `spawnSyncImpl.run`
// instead of patching the Bun global.
export interface SpawnSyncResult { success: boolean; exitCode: number; stdout: Buffer; stderr: Buffer; exitedDueToTimeout?: boolean }
export type SpawnSyncFn = (cmd: string[], opts: { stdin?: Buffer; timeout?: number }) => SpawnSyncResult;
export const spawnSyncImpl: { run: SpawnSyncFn } = {
  run: (cmd, opts) => Bun.spawnSync(cmd, { ...opts, stdout: "pipe", stderr: "pipe" }),
};

export const chat: ChatFn = async (role, messages, opts) => {
  const llm = opts.llm ?? loadLlm(opts.world);
  const endpoint = activeEndpoint(llm);
  const model = modelFor(llm, role, opts.world); // enforces locality, raises on misconfig
  if (endpoint.kind === "openai") return chatOpenai(endpoint, model, messages, { jsonMode: opts.jsonMode ?? false, maxTokens: opts.maxTokens ?? 4000 });
  if (endpoint.kind === "claude-cli") return chatClaudeCli(endpoint, model, messages, { maxTokens: opts.maxTokens ?? 4000 });
  throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has unknown kind ${JSON.stringify(endpoint.kind)}`);
};

export async function status(world: World, llm?: LlmConfig): Promise<ProviderStatus> {
  const result: ProviderStatus = { endpoint: null, kind: null, base_url: null, models: {}, reachable: null, error: null };
  const llmCfg = llm ?? loadLlm(world);
  let endpoint: Endpoint;
  try {
    endpoint = activeEndpoint(llmCfg);
  } catch (e) {
    result.error = (e as Error).message;
    return result;
  }

  result.endpoint = endpoint.name;
  result.kind = endpoint.kind;
  result.base_url = endpoint.base_url;
  for (const role of ROLES) {
    try {
      result.models[role] = modelFor(llmCfg, role, world);
    } catch (e) {
      if (e instanceof ConfigError) result.models[role] = null;
      else throw e;
    }
  }

  if (endpoint.kind !== "openai") return result;

  const base = (endpoint.base_url ?? "").replace(/\/+$/, "");
  if (!base) {
    result.reachable = false;
    result.error = "no base_url configured";
    return result;
  }
  let key: string | null;
  try {
    key = apiKey(endpoint);
  } catch (e) {
    result.reachable = false;
    result.error = (e as Error).message;
    return result;
  }
  const headers: Record<string, string> = key ? { Authorization: `Bearer ${key}` } : {};
  const url = v1Url(base) + "/models";
  try {
    const resp = await fetch(url, { headers, signal: AbortSignal.timeout(3000) });
    if (!resp.ok) {
      result.reachable = false;
      result.error = `HTTP ${resp.status}`;
    } else {
      result.reachable = true;
    }
  } catch (e) {
    // a probe reports, never raises
    result.reachable = false;
    const err = e as Error;
    result.error = `${err.name}: ${err.message}`;
  }
  return result;
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
