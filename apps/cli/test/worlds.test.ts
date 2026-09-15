import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-worlds-"));
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

describe("sil worlds add", () => {
  test("--layout v1 uses the V1 dotfiles-next layout", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const code = await run(["worlds", "add", "raqz", "--layout", "v1"]);
    expect(code).toBe(0);

    const cfgText = readFileSync(paths.configFile(), "utf8");
    expect(cfgText).toContain("raqz");
    expect(cfgText).toContain("claude/skills");
    expect(cfgText).toContain("global.CLAUDE.md");
  });

  test("adding a world with a name already in use fails with ConfigError, exit 2", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);
    const code = await run(["worlds", "add", "default"]);
    expect(code).toBe(2);
  });
});
