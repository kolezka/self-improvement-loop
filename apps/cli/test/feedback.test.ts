import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-feedback-"));
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

describe("sil feedback add", () => {
  test("writes one jsonl line with the world, ref and vote", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const code = await run(["feedback", "add", "hook:foo-bar", "good", "--note", "helped"]);
    expect(code).toBe(0);

    expect(existsSync(paths.humanFeedbackFile())).toBe(true);
    const lines = readFileSync(paths.humanFeedbackFile(), "utf8").trim().split("\n");
    expect(lines.length).toBe(1);
    const entry = JSON.parse(lines[0]!);
    expect(entry.world).toBe("default");
    expect(entry.ref).toBe("hook:foo-bar");
    expect(entry.vote).toBe("good");
    expect(entry.note).toBe("helped");
  });

  test("rejects a vote that is not good or bad", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);
    const code = await run(["feedback", "add", "hook:foo-bar", "maybe"]);
    expect(code).toBe(1);
  });
});
