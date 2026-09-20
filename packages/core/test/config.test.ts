import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeEndpoint,
  apiKey,
  Config,
  ConfigError,
  Endpoint,
  endpointFor,
  LlmConfig,
  loadConfig,
  loadLlm,
  LocalityViolation,
  modelFor,
  ModelNotConfigured,
  paths,
  resolveRole,
  saveConfig,
  saveLlm,
  useEndpoint,
  World,
  worldForCwd,
  writeHookSnapshot,
} from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-core-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

describe("config", () => {
  test("defaults parse from an empty object", () => {
    const cfg = Config.parse({});
    expect(cfg.worlds.map((w) => w.name)).toEqual(["default"]);
    expect(cfg.promotion.threshold).toBe(3);
    expect(cfg.worker.min_tool_uses).toBe(6);
  });

  test("round trips through yaml", () => {
    const cfg = Config.parse({ worlds: [{ name: "w1", repos: ["/tmp/a"], llm: "local" }] });
    saveConfig(cfg);
    const back = loadConfig();
    expect(back.worlds[0]!.name).toBe("w1");
    expect(back.worlds[0]!.llm).toBe("local");
  });

  test("world name must be a safe component", () => {
    expect(() => World.parse({ name: "../x" })).toThrow();
  });

  test("worldForCwd picks the longest prefix and resolves symlinks", () => {
    const real = join(tmp, "real", "proj");
    mkdirSync(join(real, "sub"), { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(join(tmp, "real"), link);
    const cfg = Config.parse({
      worlds: [
        { name: "default" },
        { name: "byroot", repos: [join(tmp, "real")] },
        { name: "bysub", repos: [real] },
      ],
    });
    expect(worldForCwd(cfg, join(real, "sub")).name).toBe("bysub");
    expect(worldForCwd(cfg, join(link, "proj", "sub")).name).toBe("bysub");
    expect(worldForCwd(cfg, "/").name).toBe("default");
  });

  test("worldForCwd throws without a catch-all", () => {
    const cfg = Config.parse({ worlds: [{ name: "w", repos: ["/nonexistent/x"] }] });
    expect(() => worldForCwd(cfg, "/")).toThrow(ConfigError);
  });
});

describe("llm", () => {
  test("modelFor never defaults and enforces locality", () => {
    const llm = LlmConfig.parse({ endpoints: [{ name: "p", base_url: "http://x" }], models: { critic: "m1" }, local_models: [] });
    expect(modelFor(llm, "critic")).toBe("m1");
    expect(() => modelFor(llm, "drafter")).toThrow(ModelNotConfigured);
    const local = World.parse({ name: "l", llm: "local" });
    expect(() => modelFor(llm, "critic", local)).toThrow(LocalityViolation);
  });

  test("activeEndpoint requires a defined endpoint", () => {
    expect(() => activeEndpoint(LlmConfig.parse({}))).toThrow(ModelNotConfigured);
    expect(() => activeEndpoint(LlmConfig.parse({ endpoints: [{ name: "a" }], active: "b" }))).toThrow(ModelNotConfigured);
  });

  test("apiKey refuses a placeholder", () => {
    delete process.env["SIL_TEST_KEY_X"];
    expect(() => apiKey({ name: "e", kind: "openai", base_url: "http://x", api_key_env: "SIL_TEST_KEY_X", timeout_s: 1, models: {}, extra_body: {}, decision_threshold: 0.5 })).toThrow(ModelNotConfigured);
    expect(apiKey({ name: "c", kind: "claude-cli", base_url: null, api_key_env: null, timeout_s: 1, models: {}, extra_body: {}, decision_threshold: 0.5 })).toBeNull();
  });
});

describe("hook snapshot", () => {
  test("writes absolute nudge and rules paths per world", () => {
    const p = writeHookSnapshot(Config.parse({}));
    const snap = JSON.parse(readFileSync(p, "utf8"));
    expect(snap.worlds[0].nudges_dir).toBe(join(paths.defaultTarget("default"), "nudges"));
    expect(snap.worlds[0].rules_file).toBe(join(paths.defaultTarget("default"), "RULES.md"));
    expect(snap.worker.auto_kick).toBe(true);
  });
});

describe("broken yaml", () => {
  test("a yaml syntax error is a ConfigError naming the file, for both files", () => {
    const { writeFileSync, mkdirSync } = require("node:fs") as typeof import("node:fs");
    mkdirSync(paths.configDir(), { recursive: true });
    writeFileSync(paths.llmFile(), "endpoints:\n  - name: a\n    kind: openai\n  extra_body:\n    x: 1\n");
    writeFileSync(paths.configFile(), "worlds: [\n");
    expect(() => loadLlm()).toThrow(ConfigError);
    expect(() => loadLlm()).toThrow(/llm\.yaml/);
    expect(() => loadConfig()).toThrow(ConfigError);
  });
});


describe("endpoint routing", () => {
  const two = () =>
    LlmConfig.parse({
      endpoints: [
        { name: "litellm", kind: "openai", base_url: "http://100.64.0.3:4000", models: { critic: "zai/glm-5.3-flash", drafter: "zai/glm-5.3-flash" } },
        { name: "claude", kind: "claude-cli", models: { critic: "sonnet" } },
      ],
      active: "litellm",
    });

  test("endpointFor prefers role_endpoints, then active, then the first endpoint", () => {
    const llm = two();
    expect(endpointFor(llm, "critic").name).toBe("litellm");

    llm.role_endpoints = { critic: "claude" };
    expect(endpointFor(llm, "critic").name).toBe("claude");
    expect(endpointFor(llm, "drafter").name).toBe("litellm");

    llm.active = null;
    expect(endpointFor(llm, "drafter").name).toBe("litellm");
    expect(endpointFor(llm, "critic").name).toBe("claude");
  });

  test("an unknown endpoint name throws ModelNotConfigured naming it", () => {
    const llm = two();
    llm.role_endpoints = { critic: "nope" };
    expect(() => endpointFor(llm, "critic")).toThrow(ModelNotConfigured);
    expect(() => endpointFor(llm, "critic")).toThrow(/nope/);

    const other = two();
    other.active = "gone";
    expect(() => endpointFor(other, "judge")).toThrow(/gone/);

    expect(() => endpointFor(LlmConfig.parse({}), "critic")).toThrow(ModelNotConfigured);
  });

  test("resolveRole picks the endpoint's own model over the top level one", () => {
    const llm = two();
    llm.models = { critic: "global-model", drafter: "global-model", judge: "global-model" };
    llm.role_endpoints = { critic: "claude" };

    const critic = resolveRole(llm, "critic");
    expect(critic.endpoint.name).toBe("claude");
    expect(critic.model).toBe("sonnet");

    const drafter = resolveRole(llm, "drafter");
    expect(drafter.endpoint.name).toBe("litellm");
    expect(drafter.model).toBe("zai/glm-5.3-flash");

    // no endpoint model for judge: the top level map is the fallback
    expect(resolveRole(llm, "judge").model).toBe("global-model");
  });

  test("a missing model names the role and the endpoint", () => {
    const llm = two();
    llm.role_endpoints = { critic: "claude" };
    try {
      resolveRole(llm, "judge");
      throw new Error("expected resolveRole to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ModelNotConfigured);
      const msg = (e as Error).message;
      expect(msg).toContain("judge");
      expect(msg).toContain("litellm");
      expect(msg).toContain("llm.yaml");
    }
  });

  test("locality is still enforced on the resolved model", () => {
    const llm = two();
    llm.role_endpoints = { critic: "claude" };
    const local = World.parse({ name: "l", llm: "local" });
    expect(() => resolveRole(llm, "critic", local)).toThrow(LocalityViolation);

    llm.local_models = ["sonnet"];
    expect(resolveRole(llm, "critic", local).model).toBe("sonnet");
  });

  test("a legacy llm.yaml with only active and top level models still resolves", () => {
    saveLlm(
      LlmConfig.parse({
        endpoints: [{ name: "litellm", kind: "openai", base_url: "http://127.0.0.1:4000" }],
        active: "litellm",
        models: { critic: "m-critic", drafter: "m-drafter", judge: "m-judge" },
      }),
    );
    const back = loadLlm();
    expect(back.role_endpoints).toEqual({});
    expect(resolveRole(back, "critic").endpoint.name).toBe("litellm");
    expect(resolveRole(back, "critic").model).toBe("m-critic");
    expect(modelFor(back, "judge")).toBe("m-judge");
  });
});

describe("useEndpoint guards system-one routing", () => {
  const withJev = () =>
    LlmConfig.parse({
      endpoints: [
        { name: "jev", kind: "system-one", base_url: "http://localhost:5000", models: { judge: "jev-1" } },
        { name: "litellm", kind: "openai", base_url: "http://100.64.0.3:4000", models: { critic: "m", drafter: "m", judge: "m" } },
      ],
      active: "litellm",
    });

  test("routes a system-one endpoint to --role judge", () => {
    const llm = withJev();
    const next = useEndpoint(llm, "jev", "judge");
    expect(next.role_endpoints.judge).toBe("jev");
    expect(next.active).toBe("litellm"); // a per-role route leaves active alone
  });

  test("routing a system-one endpoint to critic or drafter throws ConfigError", () => {
    const llm = withJev();
    expect(() => useEndpoint(llm, "jev", "critic")).toThrow(ConfigError);
    expect(() => useEndpoint(llm, "jev", "drafter")).toThrow(ConfigError);
  });

  test("making a system-one endpoint active with no role throws ConfigError", () => {
    const llm = withJev();
    expect(() => useEndpoint(llm, "jev")).toThrow(ConfigError);
  });

  test("an openai endpoint is unaffected by the guard", () => {
    const llm = withJev();
    expect(useEndpoint(llm, "litellm").active).toBe("litellm");
    expect(useEndpoint(llm, "litellm", "critic").role_endpoints.critic).toBe("litellm");
  });
});

describe("Endpoint decision_threshold", () => {
  test("defaults to 0.5", () => {
    expect(Endpoint.parse({ name: "x" }).decision_threshold).toBe(0.5);
  });

  test("rejects a threshold outside 0..1", () => {
    expect(() => Endpoint.parse({ name: "x", decision_threshold: 1.5 })).toThrow();
    expect(() => Endpoint.parse({ name: "x", decision_threshold: -0.1 })).toThrow();
  });
});
