// The model transports. `chat` is the only way engine code asks a model for
// text; `decide` and `decideChoice` are the only ways it asks a System One
// endpoint (TypeSafe Jev, or Laya behind a Jev compatible server) for a typed
// decision. No base_url fallback, no placeholder key, no default model.

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
  if (endpoint.kind === "system-one") {
    throw new ProviderError(
      `endpoint ${JSON.stringify(endpoint.name)} is kind system-one and cannot serve role ${role}: ` +
        "it answers typed decisions, not text. Only the judge can run on it.",
    );
  }
  throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has unknown kind ${JSON.stringify(endpoint.kind)}`);
};

// --- typed decisions (System One) --------------------------------------------

/** One yes/no proposition. `criteria` is optional and describes each outcome.
 *
 * Noul and choice are both wired up; score has no caller here yet. */
export interface NoulQuestion {
  instructions: string;
  criteria?: { true: string; false: string };
}

export type DecideFn = (
  role: Role,
  state: string,
  questions: Record<string, NoulQuestion>,
  opts: ChatOptions,
) => Promise<Record<string, number>>;

/** One pick from a named set. `criteria` maps each option to what it means;
 * null means the option name says enough on its own. */
export interface ChoiceQuestion {
  instructions: string;
  criteria: Record<string, string | null>;
}

/** The pick, the distribution behind it, and how concentrated that
 * distribution is. `confidence` is null when the server does not report one:
 * a Jev compatible server may answer probabilities only. `model` is null when
 * the server named a model we will not print. */
export interface ChoiceAnswer {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number | null;
  model: string | null;
}

export interface DecideOptions extends ChatOptions {
  /** Overrides the endpoint's own `timeout_s` for this one call. */
  timeoutMs?: number;
}

export type DecideChoiceFn = (
  role: Role,
  state: unknown,
  questions: Record<string, ChoiceQuestion>,
  opts: DecideOptions,
) => Promise<Record<string, ChoiceAnswer>>;

/** The System One endpoint serving a role, or null when that role runs on a
 * text model. Also null when llm.yaml cannot be read: the caller's chat path
 * raises the real config error, so this must not raise a second one. */
export function systemOneEndpoint(role: Role, world: World, llm?: LlmConfig): Endpoint | null {
  let endpoint: Endpoint;
  try {
    endpoint = endpointFor(llm ?? loadLlm(world), role);
  } catch {
    return null;
  }
  return endpoint.kind === "system-one" ? endpoint : null;
}

/** P(true) per question, in one call. Questions share the state and are
 * answered independently, so a question that depends on another's answer needs
 * a second call. Every requested key is present in the reply or this raises. */
export const decide: DecideFn = async (role, state, questions, opts) => {
  const llm = opts.llm ?? loadLlm(opts.world);
  const { endpoint, model } = resolveRole(llm, role, opts.world);
  if (endpoint.kind !== "system-one") {
    throw new ProviderError(
      `endpoint ${JSON.stringify(endpoint.name)} is kind ${JSON.stringify(endpoint.kind)}: ` +
        "a typed decision needs a system-one endpoint",
    );
  }
  if (Object.keys(questions).length === 0) throw new ProviderError("decide called with no questions");
  const bodies = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: "noul", ...q }]));
  const data = await postSystemOne(endpoint, model, state, bodies);
  return readNouls(endpoint, model, questions, data);
};

/** One choice answer per question, in one call. Same endpoint rules as
 * `decide`: the role must resolve to a system-one endpoint, and locality is
 * enforced by `resolveRole`. Every requested key is present in the reply or
 * this raises, and a pick outside the question's own options raises too. */
export const decideChoice: DecideChoiceFn = async (role, state, questions, opts) => {
  const llm = opts.llm ?? loadLlm(opts.world);
  const { endpoint, model } = resolveRole(llm, role, opts.world);
  if (endpoint.kind !== "system-one") {
    throw new ProviderError(
      `endpoint ${JSON.stringify(endpoint.name)} is kind ${JSON.stringify(endpoint.kind)}: ` +
        "a typed decision needs a system-one endpoint",
    );
  }
  if (Object.keys(questions).length === 0) throw new ProviderError("decideChoice called with no questions");
  for (const [id, q] of Object.entries(questions)) {
    if (Object.keys(q.criteria).length < 2) throw new ProviderError(`question ${JSON.stringify(id)} needs at least two options`);
  }
  const bodies = Object.fromEntries(Object.entries(questions).map(([id, q]) => [id, { type: "choice", ...q }]));
  const data = await postSystemOne(endpoint, model, state, bodies, opts.timeoutMs);
  return readChoices(endpoint, model, questions, data);
};

function systemOneUrl(endpoint: Endpoint): string {
  const base = (endpoint.base_url ?? "").replace(/\/+$/, "");
  if (!base) throw new ProviderError(`endpoint ${JSON.stringify(endpoint.name)} has no base_url configured`);
  return v1Url(base) + "/systemone";
}

/** `questions` carries its own `type` per entry: the caller builds the noul or
 * choice body, this only ships it. */
async function postSystemOne(
  endpoint: Endpoint,
  model: string,
  state: unknown,
  questions: Record<string, Record<string, unknown>>,
  timeoutMs?: number,
): Promise<unknown> {
  const url = systemOneUrl(endpoint);
  const body: Record<string, unknown> = { model, state, questions };
  // Same operator override as the chat path.
  Object.assign(body, endpoint.extra_body ?? {});

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  // Laya behind a local server needs none; Jev needs a bearer token.
  const key = apiKey(endpoint);
  if (key) headers["Authorization"] = `Bearer ${key}`;

  const ms = timeoutMs ?? endpoint.timeout_s * 1000;
  // The deadline covers the body stream too, so every step that can abort maps
  // through here: a timeout during the read is still a timeout to the caller.
  const failure = (e: unknown): ProviderError => {
    const err = e as Error;
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return new ProviderTimeout(`provider ${JSON.stringify(endpoint.name)} at ${url} timed out after ${ms / 1000}s`);
    }
    return new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} unreachable: ${err.message}`);
  };

  let resp: Response;
  try {
    resp = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw failure(e);
  }
  if (!resp.ok) {
    // The status is the useful fact here, so an unreadable body names itself in
    // the detail rather than replacing the status with a timeout.
    const detail = (await resp.text().catch((e) => `<body unreadable: ${(e as Error).name}>`)).slice(0, 300);
    throw new ProviderError(`provider ${JSON.stringify(endpoint.name)} at ${url} answered HTTP ${resp.status}: ${detail}`);
  }
  let raw: string;
  try {
    raw = await resp.text();
  } catch (e) {
    throw failure(e);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new ProviderError(
      `provider ${JSON.stringify(endpoint.name)} at ${url} returned non-JSON (${raw.length} bytes): ${JSON.stringify(raw.slice(0, 300))}`,
    );
  }
}

/** The probability per question id. A missing or out of range answer raises:
 * the judge reads these as a gate, and a defaulted 0 is an approval. */
function readNouls(
  endpoint: Endpoint,
  model: string,
  questions: Record<string, NoulQuestion>,
  data: unknown,
): Record<string, number> {
  const where = `provider ${JSON.stringify(endpoint.name)} model ${JSON.stringify(model)}`;
  const answers = answersObject(where, data);
  const out: Record<string, number> = {};
  for (const id of Object.keys(questions)) {
    const answer = answers[id];
    if (!answer || typeof answer !== "object") throw new ProviderError(`${where} answered nothing for question ${JSON.stringify(id)}`);
    const value = (answer as Record<string, unknown>)["noul"];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ProviderError(`${where} answered question ${JSON.stringify(id)} with a noul of ${JSON.stringify(value)}, not a probability`);
    }
    out[id] = value;
  }
  return out;
}

/** The answers object, or a ProviderError naming what was wrong with it. */
function answersObject(where: string, data: unknown): Record<string, unknown> {
  const answers = data && typeof data === "object" ? (data as Record<string, unknown>)["answers"] : undefined;
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) throw new ProviderError(`${where} reply has no answers object`);
  return answers as Record<string, unknown>;
}

const isProbability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;

/** A server-supplied name is printed to humans, so it may not be a sentence.
 * Anything outside this shape is server text, not an identifier. */
const NAME_SHAPE = /^[A-Za-z0-9._:@/-]{1,64}$/;

/** What a rejected value may be quoted as. A model that answers a question
 * with a paragraph must not get that paragraph printed back as if the loop
 * wrote it, so only identifier-shaped values are echoed. */
function safeQuote(v: unknown): string {
  if (typeof v !== "string") {
    // A whole object pasted into an error message is the same leak as prose,
    // just with braces around it.
    const s = JSON.stringify(v) ?? "undefined";
    return s.length > 80 ? `a ${typeof v} of ${s.length} JSON characters` : s;
  }
  return NAME_SHAPE.test(v) ? JSON.stringify(v) : `a ${v.length}-character string`;
}

/** One validated choice per requested id.
 *
 * A pick outside the options that question offered raises. An answer for an id
 * nobody asked is not read at all: only the requested ids are looked up. */
function readChoices(
  endpoint: Endpoint,
  model: string,
  questions: Record<string, ChoiceQuestion>,
  data: unknown,
): Record<string, ChoiceAnswer> {
  const where = `provider ${JSON.stringify(endpoint.name)} model ${JSON.stringify(model)}`;
  const answers = answersObject(where, data);
  // The reply names the model that answered, and it is printed, so it has to
  // look like a model name. Absent means the server said nothing and ours
  // stands in; present but unprintable means we do not know who answered.
  const answered = (data as Record<string, unknown>)["model"];
  const answeredBy = answered === undefined ? model : typeof answered === "string" && NAME_SHAPE.test(answered) ? answered : null;

  const out: Record<string, ChoiceAnswer> = {};
  for (const [id, question] of Object.entries(questions)) {
    const answer = answers[id];
    if (!answer || typeof answer !== "object") throw new ProviderError(`${where} answered nothing for question ${JSON.stringify(id)}`);
    const row = answer as Record<string, unknown>;

    const picked = row["choice"];
    if (typeof picked !== "string" || !Object.hasOwn(question.criteria, picked)) {
      throw new ProviderError(
        `${where} answered question ${JSON.stringify(id)} with ${safeQuote(picked)}, ` +
          `which is not one of ${Object.keys(question.criteria).join(", ")}`,
      );
    }

    const probabilities: Record<string, number> = {};
    const raw = row["probabilities"];
    if (raw !== undefined) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new ProviderError(`${where} answered question ${JSON.stringify(id)} with probabilities that are not an object`);
      }
      for (const [option, p] of Object.entries(raw as Record<string, unknown>)) {
        // A distribution over options nobody offered is not this question's
        // distribution, and its keys would reach the report.
        if (!Object.hasOwn(question.criteria, option)) {
          throw new ProviderError(`${where} answered question ${JSON.stringify(id)} with a probability for ${safeQuote(option)}, which it was not offered`);
        }
        if (!isProbability(p)) {
          throw new ProviderError(`${where} answered question ${JSON.stringify(id)} with a probability of ${safeQuote(p)} for ${JSON.stringify(option)}`);
        }
        probabilities[option] = p;
      }
      if (!Object.hasOwn(probabilities, picked)) {
        throw new ProviderError(`${where} answered question ${JSON.stringify(id)} with no probability for its own pick ${JSON.stringify(picked)}`);
      }
    }

    const conf = row["confidence"];
    if (conf !== undefined && conf !== null && !isProbability(conf)) {
      throw new ProviderError(`${where} answered question ${JSON.stringify(id)} with a confidence of ${safeQuote(conf)}, not a probability`);
    }
    out[id] = { choice: picked, probabilities, confidence: conf === undefined || conf === null ? null : conf, model: answeredBy };
  }
  return out;
}

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
  if (endpoint.kind === "system-one") return probeSystemOne(endpoint);
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

/** A System One endpoint has no models listing to GET, so the probe is one
 * real question against the configured judge model. It costs a few input
 * tokens and proves the whole path: URL, key, model name, answer shape. */
async function probeSystemOne(endpoint: Endpoint): Promise<Probe> {
  const model = endpoint.models["judge"];
  if (!model) return { reachable: false, error: "no model for role judge configured on this endpoint" };
  const questions = { probe: { instructions: "This is a reachability probe." } };
  try {
    const data = await postSystemOne(endpoint, model, "probe", { probe: { type: "noul", ...questions.probe } }, 3000);
    readNouls(endpoint, model, questions, data);
    return { reachable: true, error: null };
  } catch (e) {
    return { reachable: false, error: (e as Error).message };
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
    const detail = (await resp.text().catch((e) => `<body unreadable: ${(e as Error).name}>`)).slice(0, 300);
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
