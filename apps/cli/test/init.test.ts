import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
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
