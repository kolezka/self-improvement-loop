import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-review-"));
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

function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const chunks: string[] = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(chunk.toString());
    return true;
  }) as typeof process.stderr.write;
  return fn()
    .then((code) => ({ code, stderr: chunks.join("") }))
    .finally(() => {
      process.stderr.write = origWrite;
    });
}

describe("sil review accept", () => {
  test("requires --reviewed-state: commander rejects before the handler runs", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const { code, stderr } = await captureStderr(() => run(["review", "accept", "some-pattern", "--world", "default"]));

    expect(code).not.toBe(0);
    expect(stderr).toContain("--reviewed-state");
  });

  test("requires --world too", async () => {
    const initCode = await run(["init"]);
    expect(initCode).toBe(0);

    const { code, stderr } = await captureStderr(() => run(["review", "accept", "some-pattern", "--reviewed-state", "abc123"]));

    expect(code).not.toBe(0);
    expect(stderr).toContain("--world");
  });
});
