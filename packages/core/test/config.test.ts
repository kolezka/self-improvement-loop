import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  activeEndpoint,
  apiKey,
  Config,
  ConfigError,
  LlmConfig,
  loadConfig,
  LocalityViolation,
  modelFor,
  ModelNotConfigured,
  paths,
  saveConfig,
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
    expect(() => apiKey({ name: "e", kind: "openai", base_url: "http://x", api_key_env: "SIL_TEST_KEY_X", timeout_s: 1 })).toThrow(ModelNotConfigured);
    expect(apiKey({ name: "c", kind: "claude-cli", base_url: null, api_key_env: null, timeout_s: 1 })).toBeNull();
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
