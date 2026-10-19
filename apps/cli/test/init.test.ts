import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadLlm, paths, targetRoot, worldNamed } from "@sil/core";
import { git } from "@sil/curriculum";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-init-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "HOME", "PATH"]) saved[k] = process.env[k];
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) process.env[k] = join(tmp, k.toLowerCase());
  // init writes ~/.local/bin/sil, so never let it reach the real home.
  process.env["HOME"] = join(tmp, "home");
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

  test("installs the sil shim so the commands it prints work", async () => {
    expect(await run(["init"])).toBe(0);
    const shim = join(tmp, "home", ".local", "bin", "sil");
    expect(existsSync(shim)).toBe(true);
    expect(statSync(shim).mode & 0o111).not.toBe(0);
  });

  test("warns when the shim directory is not on PATH", async () => {
    process.env["PATH"] = "/usr/bin:/bin";
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.join(" "));
    try {
      expect(await run(["init"])).toBe(0);
    } finally {
      console.warn = orig;
    }
    expect(warned.join("\n")).toContain(join(tmp, "home", ".local", "bin"));
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
    const code = await run(["init", "--model", "anthropic/claude-sonnet-5", "--llm-base-url", "http://127.0.0.1:4000"]);
    expect(code).toBe(0);
    const llmText = readFileSync(paths.llmFile(), "utf8");
    expect(llmText).toContain("anthropic/claude-sonnet-5");
  });
});

describe("sil init provider defaults", () => {
  // Regression: init used to write a litellm endpoint at a hardcoded tailscale
  // address (http://100.64.0.3:4000, the author's own machine) and make it
  // active by default, so a fresh install with no LITELLM_API_KEY failed every
  // reflection with ModelNotConfigured before the operator touched anything.
  test("without --llm-base-url, only the claude endpoint is written and made active", async () => {
    expect(await run(["init"])).toBe(0);
    const llm = loadLlm();
    expect(llm.endpoints.map((e) => e.name)).toEqual(["claude"]);
    expect(llm.active).toBe("claude");
    const llmText = readFileSync(paths.llmFile(), "utf8");
    expect(llmText).not.toContain("100.64.0.3");
    expect(llmText).not.toContain("litellm");
  });

  test("--llm-base-url writes and activates a litellm endpoint at that address", async () => {
    expect(await run(["init", "--llm-base-url", "http://127.0.0.1:4000"])).toBe(0);
    const llm = loadLlm();
    const litellm = llm.endpoints.find((e) => e.name === "litellm")!;
    expect(litellm.base_url).toBe("http://127.0.0.1:4000");
    expect(litellm.api_key_env).toBe("LITELLM_API_KEY");
    expect(llm.active).toBe("litellm");
    expect(llm.endpoints.map((e) => e.name)).toEqual(["claude", "litellm"]);
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
    expect(await run(["init", "--llm-base-url", "http://127.0.0.1:4000"])).toBe(0);
    const llm = loadLlm();
    expect(llm.endpoints.find((e) => e.name === "litellm")!.models).toEqual({
      critic: "deepseek/deepseek-flash",
      drafter: "deepseek/deepseek-flash",
      judge: "deepseek/deepseek-flash",
    });
  });
});

describe("sil init rules file", () => {
  // Regression: RULES.md was never created by init, only by ensureRulesFile
  // on the first promoted rule (packages/curriculum/src/artifacts.ts), so the
  // SessionStart hook had nothing to inject and the web console nothing to
  // show until a curriculum run happened to land one.
  test("creates learned/RULES.md with an empty managed block and commits it", async () => {
    expect(await run(["init"])).toBe(0);
    const cfg = loadConfig();
    const world = worldNamed(cfg, "default");
    const repo = targetRoot(world);
    const path = join(repo, "RULES.md");
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("<!--loop-rules:start-->");
    expect(text).toContain("<!--loop-rules:end-->");

    // Committed, not left as an untracked file: an untracked RULES.md would
    // block the fast-forward merge the first curriculum promotion does
    // directly against this checkout.
    expect(git.git(repo, ["status", "--porcelain", "--", "RULES.md"])).toBe("");
    expect(git.git(repo, ["log", "-1", "--format=%s", "--", "RULES.md"])).toBe("chore: seed learned rules file");
  });

  test("is idempotent: a second init does not touch an already-committed RULES.md", async () => {
    expect(await run(["init"])).toBe(0);
    const repo = targetRoot(worldNamed(loadConfig(), "default"));
    const firstSha = git.git(repo, ["rev-parse", "HEAD"]);

    expect(await run(["init"])).toBe(0);
    expect(git.git(repo, ["rev-parse", "HEAD"])).toBe(firstSha);
  });

  test("does not create a rules file for a world pointed at an operator-owned target", async () => {
    const target = join(tmp, "operator-repo");
    mkdirSync(target, { recursive: true });
    expect(await run(["init", "--target", target])).toBe(0);
    expect(existsSync(join(target, "RULES.md"))).toBe(false);
  });

  // Regression: the seeding commit had no pathspec, so it committed the whole
  // index. An unrelated file staged in the learned repo (a human's work in
  // progress, or any other process that stages before init runs) got swept
  // into "chore: seed learned rules file" along with RULES.md.
  test("committing a re-seeded rules file touches only that path, not other staged work", async () => {
    expect(await run(["init"])).toBe(0);
    const repo = targetRoot(worldNamed(loadConfig(), "default"));
    const rulesPath = join(repo, "RULES.md");

    // Remove and commit the removal, so the next init call finds nothing on
    // disk and genuinely re-seeds it (ensureRulesFile only writes when the
    // file is missing).
    git.git(repo, ["rm", "-f", "-q", "RULES.md"]);
    git.git(repo, ["commit", "-q", "-m", "test: remove rules file"]);
    expect(existsSync(rulesPath)).toBe(false);

    // Unrelated work staged but not committed in the same repo.
    writeFileSync(join(repo, "unrelated.txt"), "work in progress\n", "utf8");
    git.git(repo, ["add", "unrelated.txt"]);

    const headBefore = git.git(repo, ["rev-parse", "HEAD"]);
    expect(await run(["init"])).toBe(0);
    expect(existsSync(rulesPath)).toBe(true);

    const headAfter = git.git(repo, ["rev-parse", "HEAD"]);
    expect(headAfter).not.toBe(headBefore);

    // The new commit touches only RULES.md.
    const changed = git
      .git(repo, ["diff-tree", "--no-commit-id", "--name-only", "-r", headAfter])
      .split("\n")
      .filter(Boolean);
    expect(changed).toEqual(["RULES.md"]);

    // unrelated.txt is still staged, not committed and not unstaged.
    const status = git.git(repo, ["status", "--porcelain", "--", "unrelated.txt"]);
    expect(status).toBe("A  unrelated.txt");
    expect(git.git(repo, ["diff", "--cached", "--name-only"])).toContain("unrelated.txt");
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

  // A test can pass a fixture env here instead of mutating process.env.
  function strippedEnv(inherited: Record<string, string | undefined> = process.env): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(inherited)) {
      if (value === undefined) continue;
      if (key.startsWith("GIT_AUTHOR_") || key.startsWith("GIT_COMMITTER_") || key === "EMAIL") continue;
      // A parent process can inject identity through these. Drop them all.
      if (key === "GIT_CONFIG_PARAMETERS" || key === "GIT_CONFIG_COUNT" || /^GIT_CONFIG_(KEY|VALUE)_\d+$/.test(key)) continue;
      env[key] = value;
    }
    // An empty file is a config with nothing in it, so git reads no identity
    // from the global or the system scope.
    env["GIT_CONFIG_GLOBAL"] = "/dev/null";
    env["GIT_CONFIG_SYSTEM"] = "/dev/null";
    // Also reject git's OS-level identity guess, not just a configured one,
    // so an intact environment can never pass as the no-identity control.
    env["GIT_CONFIG_COUNT"] = "1";
    env["GIT_CONFIG_KEY_0"] = "user.useConfigOnly";
    env["GIT_CONFIG_VALUE_0"] = "true";
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

  test("strippedEnv rejects an identity inherited through command-scope git config", () => {
    // A parent process can already have these set to inject an identity.
    // A fresh object, not process.env, so this fixture cannot leak elsewhere.
    const inherited: Record<string, string | undefined> = {
      ...process.env,
      GIT_CONFIG_COUNT: "3",
      GIT_CONFIG_KEY_0: "user.useConfigOnly",
      GIT_CONFIG_VALUE_0: "false",
      GIT_CONFIG_KEY_1: "user.name",
      GIT_CONFIG_VALUE_1: "Fixture Name",
      GIT_CONFIG_KEY_2: "user.email",
      GIT_CONFIG_VALUE_2: "fixture@example.invalid",
      GIT_CONFIG_PARAMETERS: "'user.name=Fixture Parameters' 'user.email=fixture-parameters@example.invalid'",
    };

    const env = strippedEnv(inherited);

    const repo = join(tmp, "inherited-config");
    mkdirSync(repo, { recursive: true });
    expect(Bun.spawnSync(["git", "init", "-q", "-b", "main", repo], { env }).exitCode).toBe(0);
    expect(commits(repo, env)).toBe(false);
  });
});
