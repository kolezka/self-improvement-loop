import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError, LocalityViolation, ModelNotConfigured, ProviderError, ProviderTimeout } from "@sil/core";
import type { Endpoint, LlmConfig, World } from "@sil/core";
import { chat, spawnSyncImpl, type SpawnSyncResult } from "../src/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function world(overrides: Partial<World> = {}): World {
  return { name: "w1", llm: "cloud", repos: [], target: null, layout: { skills_dir: "skills", nudges_dir: "nudges", agents_dir: "agents", rules_file: "RULES.md", ledger: "promotions.json" }, remote: "none", rules_inject: true, outline: null, llm_config: null, ...overrides };
}

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { endpoints: [], active: null, local_models: [], models: {}, ...overrides };
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return { name: "e1", kind: "openai", base_url: null, api_key_env: null, timeout_s: 240, extra_body: {}, ...overrides };
}

function fakeResponse(body: unknown, init: { status?: number } = {}): Response {
  return new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "Content-Type": "application/json" } });
}

// --- openai kind: request shape ---------------------------------------------

describe("chat openai request shape", () => {
  test("builds url, headers and body", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return fakeResponse({ choices: [{ message: { content: "hello" } }] });
    }) as typeof fetch;

    process.env["TEST_KEY_ENV"] = "secret-123";
    const ep = endpoint({ base_url: "http://localhost:4000/v1", api_key_env: "TEST_KEY_ENV", timeout_s: 30 });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "gpt-test" } });

    const result = await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm, jsonMode: true });

    expect(result).toBe("hello");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://localhost:4000/v1/chat/completions");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBe("Bearer secret-123");

    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.model).toBe("gpt-test");
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    delete process.env["TEST_KEY_ENV"];
  });

  test("appends /v1 when base_url lacks it", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return fakeResponse({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;

    const ep = endpoint({ base_url: "http://localhost:4000", api_key_env: null });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "gpt-test" } });

    await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm });

    expect(calls[0]!.url).toBe("http://localhost:4000/v1/chat/completions");
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get("Authorization")).toBeNull(); // no api_key_env: no auth header
  });
});

// --- config errors propagate unwrapped --------------------------------------

describe("chat config errors", () => {
  function denyNetwork() {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      throw new Error("must not reach the network");
    }) as unknown as typeof fetch;
  }

  test("raises ModelNotConfigured when role missing", async () => {
    denyNetwork();
    const ep = endpoint({ base_url: "http://localhost:4000", api_key_env: null });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: {} });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ModelNotConfigured);
  });

  test("raises LocalityViolation for a local world", async () => {
    denyNetwork();
    const ep = endpoint({ base_url: "http://localhost:4000", api_key_env: null });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "gpt-cloud-only" }, local_models: ["llama-local"] });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world({ llm: "local" }), llm })).rejects.toBeInstanceOf(LocalityViolation);
  });

  test("never falls back to localhost when base_url missing", async () => {
    denyNetwork();
    const ep = endpoint({ base_url: null, api_key_env: null });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "gpt-test" } });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ProviderError);
  });

  test("raises ModelNotConfigured with no endpoints at all", async () => {
    denyNetwork();
    const llm = llmConfig({ endpoints: [], active: null, models: { critic: "gpt-test" } });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ModelNotConfigured);
  });
});

// --- error surfaces name endpoint, url, status ------------------------------

describe("chat openai error surface", () => {
  test("http error names endpoint and status", async () => {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => fakeResponse("boom", { status: 500 })) as unknown as typeof fetch;
    const ep = endpoint({ name: "myendpoint", base_url: "http://localhost:4000", api_key_env: null });
    const llm = llmConfig({ endpoints: [ep], active: "myendpoint", models: { critic: "gpt-test" } });

    try {
      await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm });
      throw new Error("expected chat to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError);
      expect((e as Error).message).toContain("myendpoint");
      expect((e as Error).message).toContain("500");
    }
  });

  test("timeout maps to ProviderTimeout", async () => {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      const err = new DOMException("The operation timed out.", "TimeoutError");
      throw err;
    }) as unknown as typeof fetch;
    const ep = endpoint({ base_url: "http://localhost:4000", api_key_env: null });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "gpt-test" } });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ProviderTimeout);
  });
});

// --- claude-cli kind ---------------------------------------------------------

describe("chat claude-cli kind", () => {
  const originalRun = spawnSyncImpl.run;
  afterEach(() => {
    spawnSyncImpl.run = originalRun;
  });

  function fakeResult(overrides: Partial<SpawnSyncResult> = {}): SpawnSyncResult {
    return { success: true, exitCode: 0, stdout: Buffer.from(""), stderr: Buffer.from(""), ...overrides };
  }

  test("uses result field and builds expected argv", async () => {
    const calls: string[][] = [];
    spawnSyncImpl.run = (cmd) => {
      calls.push(cmd);
      return fakeResult({ stdout: Buffer.from(JSON.stringify({ result: "cli answer" })) });
    };
    const ep = endpoint({ name: "cli", kind: "claude-cli" });
    const llm = llmConfig({ endpoints: [ep], active: "cli", models: { critic: "opus" } });

    const result = await chat(
      "critic",
      [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
      { world: world(), llm },
    );

    expect(result).toBe("cli answer");
    const chatCall = calls.find((c) => c.includes("-p"))!;
    expect(chatCall).toContain("--model");
    expect(chatCall).toContain("opus");
    expect(chatCall).toContain("--output-format");
    expect(chatCall).toContain("json");
    expect(chatCall).toContain("--append-system-prompt");
    expect(chatCall).toContain("sys");
  });

  test("raises on missing result field", async () => {
    spawnSyncImpl.run = () => fakeResult({ stdout: Buffer.from(JSON.stringify({ not_result: "x" })) });
    const ep = endpoint({ name: "cli", kind: "claude-cli" });
    const llm = llmConfig({ endpoints: [ep], active: "cli", models: { critic: "opus" } });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ProviderError);
  });

  test("raises ProviderError on non-zero exit", async () => {
    spawnSyncImpl.run = () => fakeResult({ success: false, exitCode: 1, stderr: Buffer.from("boom") });
    const ep = endpoint({ name: "cli", kind: "claude-cli" });
    const llm = llmConfig({ endpoints: [ep], active: "cli", models: { critic: "opus" } });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ProviderError);
  });

  test("raises ProviderTimeout when the spawn exited due to timeout", async () => {
    spawnSyncImpl.run = () => fakeResult({ success: false, exitedDueToTimeout: true });
    const ep = endpoint({ name: "cli", kind: "claude-cli" });
    const llm = llmConfig({ endpoints: [ep], active: "cli", models: { critic: "opus" } });

    await expect(chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).rejects.toBeInstanceOf(ProviderTimeout);
  });
});

// --- openai kind: reasoning models ------------------------------------------

describe("chat openai extra_body and empty replies", () => {
  test("extra_body is merged into the request last", async () => {
    const calls: { init: RequestInit }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      calls.push({ init });
      return fakeResponse({ choices: [{ message: { content: "ok" } }] });
    }) as typeof fetch;
    const ep = endpoint({ base_url: "http://localhost:4000", extra_body: { reasoning_effort: "low", max_tokens: 9000 } });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "m" } });
    await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm, jsonMode: true });
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.reasoning_effort).toBe("low");
    expect(body.max_tokens).toBe(9000);
    expect(body.response_format).toEqual({ type: "json_object" });
  });

  test("an empty content from a reasoning model is a ProviderError that names the remedy", async () => {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) =>
      fakeResponse({
        choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "thinking..." } }],
        usage: { completion_tokens: 4000, completion_tokens_details: { reasoning_tokens: 3994 } },
      })) as unknown as typeof fetch;
    const ep = endpoint({ base_url: "http://localhost:4000" });
    const llm = llmConfig({ endpoints: [ep], active: "e1", models: { critic: "glm" } });
    let err: unknown;
    try {
      await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm, jsonMode: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProviderError);
    const msg = String((err as Error).message);
    expect(msg).toContain("empty content");
    expect(msg).toContain("length");
    expect(msg).toContain("3994 reasoning tokens");
    expect(msg).toContain("extra_body");
  });
});

