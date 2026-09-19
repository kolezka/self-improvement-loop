import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadLlm, paths, targetRoot, worldNamed } from "@sil/core";
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

describe("sil init on a machine with no git identity", () => {
  // The loop commits into its own learned/ repo on every staged artifact and
  // every accept. A machine where git can resolve no name and no address (CI, a
  // fresh container, an operator who sets identity per repo) fails all of them
  // with "Author identity unknown", and a curriculum run reports that as one
  // pattern gated out rather than as a broken install. So init has to leave the
  // repo able to commit on its own.
  //
  // Spawned rather than called in process: a git subprocess reads the
  // environment this process started with, not one it changed since.
  const CLI = join(import.meta.dir, "..", "src", "main.ts");

  function strippedEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue;
      if (key.startsWith("GIT_AUTHOR_") || key.startsWith("GIT_COMMITTER_") || key === "EMAIL") continue;
      env[key] = value;
    }
    // An empty file is a config with nothing in it, so git reads no identity
    // from the global or the system scope.
    env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    env["GIT_CONFIG_SYSTEM"] = "/dev/null";
    return env;
  }

  function commits(repo: string, env: Record<string, string>): boolean {
    return Bun.spawnSync(["git", "-C", repo, "commit", "-q", "--allow-empty", "-m", "probe"], { env, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
  }

  test("the learned repo it creates can commit", () => {
    const env = strippedEnv();

    // Positive control: prove the stripped environment really has no identity,
    // so a passing assertion below cannot be the environment being intact.
    const bare = join(tmp, "control");
    mkdirSync(bare, { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", bare], { env }).exitCode).toBe(0);
    expect(commits(bare, env)).toBe(false);

    const init = Bun.spawnSync(["bun", CLI, "init"], { env, stdout: "pipe", stderr: "pipe" });
    expect(init.exitCode).toBe(0);

    const cfg = loadConfig();
    expect(commits(targetRoot(worldNamed(cfg, "default")), env)).toBe(true);
  });
});
