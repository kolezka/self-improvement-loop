import { afterEach, describe, expect, test } from "bun:test";
import { ConfigError, LocalityViolation, ModelNotConfigured, ProviderError, ProviderTimeout } from "@sil/core";
import type { Endpoint, LlmConfig, World } from "@sil/core";
import { chat, decide, spawnSyncImpl, status, systemOneEndpoint, type NoulQuestion, type SpawnSyncResult } from "../src/index.ts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function world(overrides: Partial<World> = {}): World {
  return { name: "w1", llm: "cloud", repos: [], target: null, layout: { skills_dir: "skills", nudges_dir: "nudges", agents_dir: "agents", rules_file: "RULES.md", ledger: "promotions.json" }, remote: "none", rules_inject: true, outline: null, llm_config: null, ...overrides };
}

function llmConfig(overrides: Partial<LlmConfig> = {}): LlmConfig {
  return { endpoints: [], active: null, role_endpoints: {}, local_models: [], models: {}, ...overrides };
}

function endpoint(overrides: Partial<Endpoint> = {}): Endpoint {
  return { name: "e1", kind: "openai", base_url: null, api_key_env: null, timeout_s: 240, models: {}, extra_body: {}, decision_threshold: 0.5, ...overrides };
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


// --- per role endpoint routing ----------------------------------------------

describe("chat routes each role to its own endpoint", () => {
  const originalRun = spawnSyncImpl.run;
  afterEach(() => {
    spawnSyncImpl.run = originalRun;
  });

  test("critic goes to the role endpoint, drafter to the active one", async () => {
    const urls: string[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      urls.push(String(url) + " " + String(JSON.parse(String(init.body)).model));
      return fakeResponse({ choices: [{ message: { content: "openai answer" } }] });
    }) as typeof fetch;

    const llm = llmConfig({
      endpoints: [
        endpoint({ name: "fast", base_url: "http://fast:4000", models: { critic: "fast-critic", drafter: "fast-drafter", judge: "fast-judge" } }),
        endpoint({ name: "slow", base_url: "http://slow:4000", models: { critic: "slow-critic", drafter: "slow-drafter", judge: "slow-judge" } }),
      ],
      active: "fast",
      role_endpoints: { critic: "slow" },
    });

    expect(await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).toBe("openai answer");
    expect(await chat("drafter", [{ role: "user", content: "hi" }], { world: world(), llm })).toBe("openai answer");

    expect(urls).toEqual([
      "http://slow:4000/v1/chat/completions slow-critic",
      "http://fast:4000/v1/chat/completions fast-drafter",
    ]);
  });

  test("critic can run on claude-cli while drafter stays on the openai endpoint", async () => {
    const spawned: string[][] = [];
    spawnSyncImpl.run = (cmd) => {
      spawned.push(cmd);
      return { success: true, exitCode: 0, stdout: Buffer.from(JSON.stringify({ result: "cli answer" })), stderr: Buffer.from("") };
    };
    const bodies: Record<string, unknown>[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return fakeResponse({ choices: [{ message: { content: "proxy answer" } }] });
    }) as typeof fetch;

    const llm = llmConfig({
      endpoints: [
        endpoint({ name: "litellm", base_url: "http://100.64.0.3:4000", models: { critic: "zai/glm-5.3-flash", drafter: "zai/glm-5.3-flash", judge: "zai/glm-5.3-flash" } }),
        endpoint({ name: "claude", kind: "claude-cli", models: { critic: "sonnet", drafter: "sonnet", judge: "sonnet" } }),
      ],
      active: "litellm",
      role_endpoints: { critic: "claude" },
    });

    expect(await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm })).toBe("cli answer");
    expect(await chat("drafter", [{ role: "user", content: "hi" }], { world: world(), llm })).toBe("proxy answer");

    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toContain("sonnet");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!["model"]).toBe("zai/glm-5.3-flash");
  });
});

// --- status ------------------------------------------------------------------

describe("status", () => {
  const originalRun = spawnSyncImpl.run;
  afterEach(() => {
    spawnSyncImpl.run = originalRun;
  });

  function twoEndpoints() {
    return llmConfig({
      endpoints: [
        endpoint({ name: "litellm", base_url: "http://100.64.0.3:4000", models: { drafter: "zai/glm-5.3-flash", judge: "zai/glm-5.3-flash" } }),
        endpoint({ name: "claude", kind: "claude-cli", models: { critic: "sonnet" } }),
      ],
      active: "litellm",
      role_endpoints: { critic: "claude" },
    });
  }

  test("lists both endpoints with reachability and never throws when one is down", async () => {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    spawnSyncImpl.run = () => ({ success: true, exitCode: 0, stdout: Buffer.from("2.1.0\n"), stderr: Buffer.from("") });

    const result = await status(world(), twoEndpoints());

    expect(result.endpoints.map((e) => e.name)).toEqual(["litellm", "claude"]);

    const litellm = result.endpoints.find((e) => e.name === "litellm")!;
    expect(litellm.kind).toBe("openai");
    expect(litellm.base_url).toBe("http://100.64.0.3:4000");
    expect(litellm.active).toBe(true);
    expect(litellm.roles).toEqual(["drafter", "judge"]);
    expect(litellm.models).toEqual({ drafter: "zai/glm-5.3-flash", judge: "zai/glm-5.3-flash" });
    expect(litellm.reachable).toBe(false);
    expect(litellm.error).toContain("connection refused");

    const claude = result.endpoints.find((e) => e.name === "claude")!;
    expect(claude.kind).toBe("claude-cli");
    expect(claude.active).toBe(false);
    expect(claude.roles).toEqual(["critic"]);
    expect(claude.reachable).toBe(true);
    expect(claude.error).toBeNull();
  });

  test("keeps the top level fields pointed at the endpoint that serves critic", async () => {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => fakeResponse({ data: [] })) as unknown as typeof fetch;
    spawnSyncImpl.run = () => ({ success: false, exitCode: 127, stdout: Buffer.from(""), stderr: Buffer.from("not found") });

    const result = await status(world(), twoEndpoints());

    expect(result.endpoint).toBe("claude");
    expect(result.kind).toBe("claude-cli");
    expect(result.base_url).toBeNull();
    expect(result.reachable).toBe(false);
    expect(result.models).toEqual({ critic: "sonnet", drafter: "zai/glm-5.3-flash", judge: "zai/glm-5.3-flash" });
  });

  test("a claude-cli binary that is missing is reported, not thrown", async () => {
    spawnSyncImpl.run = () => {
      throw new Error("ENOENT");
    };
    const llm = llmConfig({ endpoints: [endpoint({ name: "claude", kind: "claude-cli", models: { critic: "sonnet" } })], active: "claude" });

    const result = await status(world(), llm);

    expect(result.endpoints).toHaveLength(1);
    expect(result.endpoints[0]!.reachable).toBe(false);
    expect(result.endpoints[0]!.error).toContain("ENOENT");
  });

  test("an llm.yaml with no endpoints reports the problem instead of throwing", async () => {
    const result = await status(world(), llmConfig());
    expect(result.endpoints).toEqual([]);
    expect(result.endpoint).toBeNull();
    expect(result.error).toContain("no endpoints");
    expect(result.models).toEqual({ critic: null, drafter: null, judge: null });
  });
});

// --- system-one kind ---------------------------------------------------------

describe("system-one kind", () => {
  function systemOneConfig(overrides: Partial<Endpoint> = {}): { ep: Endpoint; llm: LlmConfig } {
    const ep = endpoint({ name: "jev", kind: "system-one", base_url: "http://localhost:5000", models: { judge: "jev-1" }, ...overrides });
    return { ep, llm: llmConfig({ endpoints: [ep], active: "jev" }) };
  }

  function denyNetwork() {
    globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
      throw new Error("must not reach the network");
    }) as unknown as typeof fetch;
  }

  describe("decide request shape", () => {
    test("posts model, state and questions with noul type merged in, and the Authorization header", async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return fakeResponse({ answers: { q1: { type: "noul", noul: 0.7 } } });
      }) as typeof fetch;

      process.env["TEST_SO_KEY"] = "jev-secret";
      const { llm } = systemOneConfig({ base_url: "http://localhost:5000/v1", api_key_env: "TEST_SO_KEY" });

      const result = await decide("judge", "state text", { q1: { instructions: "is it done?" } }, { world: world(), llm });

      expect(result).toEqual({ q1: 0.7 });
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe("http://localhost:5000/v1/systemone");
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("Authorization")).toBe("Bearer jev-secret");

      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.model).toBe("jev-1");
      expect(body.state).toBe("state text");
      expect(body.questions).toEqual({ q1: { type: "noul", instructions: "is it done?" } });
      delete process.env["TEST_SO_KEY"];
    });

    test("appends /v1 when base_url lacks it, and sends no Authorization when api_key_env is null", async () => {
      const calls: { url: string; init: RequestInit }[] = [];
      globalThis.fetch = (async (url: string, init: RequestInit) => {
        calls.push({ url: String(url), init });
        return fakeResponse({ answers: { q1: { type: "noul", noul: 0.5 } } });
      }) as typeof fetch;

      const { llm } = systemOneConfig({ base_url: "http://localhost:5000", api_key_env: null });

      await decide("judge", "state text", { q1: { instructions: "is it done?" } }, { world: world(), llm });

      expect(calls[0]!.url).toBe("http://localhost:5000/v1/systemone");
      const headers = new Headers(calls[0]!.init.headers);
      expect(headers.get("Authorization")).toBeNull();
    });

    test("extra_body is merged into the request last", async () => {
      const calls: { init: RequestInit }[] = [];
      globalThis.fetch = (async (_url: string, init: RequestInit) => {
        calls.push({ init });
        return fakeResponse({ answers: { q1: { type: "noul", noul: 0.5 } } });
      }) as typeof fetch;

      const { llm } = systemOneConfig({ extra_body: { model: "override-model", trace: true } });

      await decide("judge", "state", { q1: { instructions: "x" } }, { world: world(), llm });

      const body = JSON.parse(String(calls[0]!.init.body));
      expect(body.model).toBe("override-model");
      expect(body.trace).toBe(true);
    });
  });

  describe("decide happy path", () => {
    test("returns a probability per requested key", async () => {
      globalThis.fetch = (async () => fakeResponse({ answers: { x: { type: "noul", noul: 0.91 } } })) as unknown as typeof fetch;
      const { llm } = systemOneConfig();

      const result = await decide("judge", "state", { x: { instructions: "is it done?" } }, { world: world(), llm });

      expect(result).toEqual({ x: 0.91 });
    });
  });

  describe("decide error surface", () => {
    function runDecide(questions: Record<string, NoulQuestion> = { x: { instructions: "is it done?" } }, llmOverride?: LlmConfig) {
      const { llm } = systemOneConfig();
      return decide("judge", "state", questions, { world: world(), llm: llmOverride ?? llm });
    }

    test("raises when answers is missing", async () => {
      globalThis.fetch = (async () => fakeResponse({})) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when a requested question id is absent from answers", async () => {
      globalThis.fetch = (async () => fakeResponse({ answers: { other: { type: "noul", noul: 0.5 } } })) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when noul is not a number", async () => {
      globalThis.fetch = (async () => fakeResponse({ answers: { x: { type: "noul", noul: "0.5" } } })) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when noul is not finite", async () => {
      // JSON has no NaN literal; an overflowing exponent parses to Infinity and hits the same isFinite guard.
      globalThis.fetch = (async () =>
        new Response('{"answers":{"x":{"type":"noul","noul":1e400}}}', { status: 200, headers: { "Content-Type": "application/json" } })) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when noul is below 0", async () => {
      globalThis.fetch = (async () => fakeResponse({ answers: { x: { type: "noul", noul: -0.1 } } })) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when noul is above 1", async () => {
      globalThis.fetch = (async () => fakeResponse({ answers: { x: { type: "noul", noul: 1.1 } } })) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when the response is not JSON", async () => {
      globalThis.fetch = (async () => new Response("not json", { status: 200 })) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when HTTP is not ok, naming the status and body head", async () => {
      globalThis.fetch = (async () => fakeResponse("boom", { status: 500 })) as unknown as typeof fetch;
      try {
        await runDecide();
        throw new Error("expected decide to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError);
        expect((e as Error).message).toContain("500");
        expect((e as Error).message).toContain("boom");
      }
    });

    test("raises ProviderTimeout on an aborted fetch", async () => {
      globalThis.fetch = (async (_input: unknown, _init?: unknown) => {
        const err = new DOMException("The operation timed out.", "TimeoutError");
        throw err;
      }) as unknown as typeof fetch;
      await expect(runDecide()).rejects.toBeInstanceOf(ProviderTimeout);
    });

    test("raises when the role's endpoint is kind openai", async () => {
      denyNetwork();
      const ep = endpoint({ kind: "openai", base_url: "http://localhost:4000", models: { judge: "gpt-judge" } });
      const llm = llmConfig({ endpoints: [ep], active: "e1" });
      await expect(runDecide(undefined, llm)).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when the role's endpoint is kind claude-cli", async () => {
      denyNetwork();
      const ep = endpoint({ kind: "claude-cli", models: { judge: "sonnet" } });
      const llm = llmConfig({ endpoints: [ep], active: "e1" });
      await expect(runDecide(undefined, llm)).rejects.toBeInstanceOf(ProviderError);
    });

    test("raises when questions is empty", async () => {
      denyNetwork();
      await expect(runDecide({})).rejects.toBeInstanceOf(ProviderError);
    });
  });

  describe("chat refuses a system-one endpoint", () => {
    test("names the role and says only the judge can run on it", async () => {
      const { llm } = systemOneConfig({ models: { critic: "jev-1" } });
      try {
        await chat("critic", [{ role: "user", content: "hi" }], { world: world(), llm });
        throw new Error("expected chat to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ProviderError);
        expect((e as Error).message).toContain("critic");
        expect((e as Error).message).toContain("judge");
      }
    });
  });

  describe("status for a system-one endpoint", () => {
    test("reachable true when the probe answers a valid noul", async () => {
      globalThis.fetch = (async () => fakeResponse({ answers: { probe: { type: "noul", noul: 0.5 } } })) as unknown as typeof fetch;
      const { llm } = systemOneConfig();

      const result = await status(world(), llm);

      const jev = result.endpoints.find((e) => e.name === "jev")!;
      expect(jev.reachable).toBe(true);
      expect(jev.error).toBeNull();
    });

    test("reachable false with the reason when the endpoint has no models.judge", async () => {
      denyNetwork();
      const { llm } = systemOneConfig({ models: {} });

      const result = await status(world(), llm);

      const jev = result.endpoints.find((e) => e.name === "jev")!;
      expect(jev.reachable).toBe(false);
      expect(jev.error).toContain("judge");
    });

    test("reachable false when the probe request fails", async () => {
      globalThis.fetch = (async () => {
        throw new Error("connection refused");
      }) as unknown as typeof fetch;
      const { llm } = systemOneConfig();

      const result = await status(world(), llm);

      const jev = result.endpoints.find((e) => e.name === "jev")!;
      expect(jev.reachable).toBe(false);
      expect(jev.error).toContain("connection refused");
    });
  });

  describe("systemOneEndpoint", () => {
    test("returns the endpoint when the judge runs on it", () => {
      const { llm } = systemOneConfig();
      expect(systemOneEndpoint("judge", world(), llm)?.name).toBe("jev");
    });

    test("returns null when the judge runs on an openai endpoint", () => {
      const ep = endpoint({ name: "gpt", kind: "openai", base_url: "http://localhost:4000", models: { judge: "gpt-judge" } });
      const llm = llmConfig({ endpoints: [ep], active: "gpt" });
      expect(systemOneEndpoint("judge", world(), llm)).toBeNull();
    });

    test("returns null, not a throw, when the config cannot resolve an endpoint at all", () => {
      const llm = llmConfig({ endpoints: [], active: null });
      expect(systemOneEndpoint("judge", world(), llm)).toBeNull();
    });
  });
});
