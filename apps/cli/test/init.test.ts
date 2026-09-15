import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLlm, paths } from "@sil/core";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-init-"));
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

describe("sil init", () => {
  test("writes config.yaml, llm.yaml and the hook snapshot", async () => {
    const code = await run(["init"]);
    expect(code).toBe(0);
    expect(existsSync(paths.configFile())).toBe(true);
    expect(existsSync(paths.llmFile())).toBe(true);
    expect(existsSync(paths.hookSnapshotFile())).toBe(true);

    const cfgText = readFileSync(paths.configFile(), "utf8");
    expect(cfgText).toContain("default");
  });

  test("is idempotent: a second run does not overwrite existing files", async () => {
    const first = await run(["init"]);
    expect(first).toBe(0);
    const before = readFileSync(paths.configFile(), "utf8");

    const second = await run(["init"]);
    expect(second).toBe(0);
    const after = readFileSync(paths.configFile(), "utf8");
    expect(after).toBe(before);
  });

  test("--model fills in llm.yaml models", async () => {
    const code = await run(["init", "--model", "anthropic/claude-sonnet-5"]);
    expect(code).toBe(0);
    const llmText = readFileSync(paths.llmFile(), "utf8");
    expect(llmText).toContain("anthropic/claude-sonnet-5");
  });
});

describe("sil init provider defaults", () => {
  test("defaults the litellm endpoint to the tailscale address", async () => {
    expect(await run(["init"])).toBe(0);
    const llm = loadLlm();
    const litellm = llm.endpoints.find((e) => e.name === "litellm")!;
    expect(litellm.base_url).toBe("http://100.64.0.3:4000");
    expect(litellm.api_key_env).toBe("LITELLM_API_KEY");
    expect(llm.active).toBe("litellm");
  });

  test("seeds the claude endpoint with a model for all three roles", async () => {
    expect(await run(["init"])).toBe(0);
    const claude = loadLlm().endpoints.find((e) => e.name === "claude")!;
    expect(claude.kind).toBe("claude-cli");
    expect(claude.models).toEqual({ critic: "sonnet", drafter: "sonnet", judge: "sonnet" });
  });

  test("--claude-model overrides the claude endpoint models", async () => {
    expect(await run(["init", "--claude-model", "opus"])).toBe(0);
    expect(loadLlm().endpoints.find((e) => e.name === "claude")!.models).toEqual({ critic: "opus", drafter: "opus", judge: "opus" });
  });

  test("--model fills the litellm endpoint, not the top level map", async () => {
    expect(await run(["init", "--model", "zai/glm-5.3-flash", "--llm-base-url", "http://127.0.0.1:4000"])).toBe(0);
    const llm = loadLlm();
    expect(llm.endpoints.find((e) => e.name === "litellm")!.models).toEqual({
      critic: "zai/glm-5.3-flash",
      drafter: "zai/glm-5.3-flash",
      judge: "zai/glm-5.3-flash",
    });
    expect(llm.endpoints.find((e) => e.name === "litellm")!.base_url).toBe("http://127.0.0.1:4000");
    expect(llm.models).toEqual({});
  });

  test("without --model the litellm endpoint gets the DeepSeek default for every role", async () => {
    expect(await run(["init"])).toBe(0);
    const llm = loadLlm();
    expect(llm.endpoints.find((e) => e.name === "litellm")!.models).toEqual({
      critic: "deepseek/deepseek-flash",
      drafter: "deepseek/deepseek-flash",
      judge: "deepseek/deepseek-flash",
    });
  });
});
