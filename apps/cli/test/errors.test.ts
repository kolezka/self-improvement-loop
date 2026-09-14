import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-errors-"));
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

describe("known domain errors map to exit 2 with no stack trace", () => {
  test("ConfigError (duplicate world name) prints one error line, no stack", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const errs: string[] = [];
    const origErr = console.error;
    console.error = (...args: unknown[]) => errs.push(args.map(String).join(" "));
    let code: number;
    try {
      code = await run(["worlds", "add", "default"]);
    } finally {
      console.error = origErr;
    }

    expect(code).toBe(2);
    expect(errs.length).toBe(1);
    expect(errs[0]).toContain("already exists");
    expect(errs[0]).not.toContain("at ");
    expect(errs[0]).not.toContain(".ts:");
  });
});
