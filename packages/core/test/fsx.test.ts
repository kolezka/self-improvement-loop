import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine } from "../src/fsx.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sil-fsx-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("appendLine rotation", () => {
  test("a file of long lines shrinks below the threshold, not just below the line cap", () => {
    // 2000 lines of 1.5 KB are 3 MB. A line-only cut of 2000 keeps all of
    // them, the file stays over a 2 MB threshold, and every append after that
    // rewrites the whole file. Measured at 3.3 ms per tool call on a warm cache.
    const path = join(dir, "samples.jsonl");
    const rotateAt = 2 * 1024 * 1024;
    const keep = 2000;
    const line = "x".repeat(1500);
    // Seeded directly: going through appendLine would rotate mid-seed.
    writeFileSync(path, Array.from({ length: keep }, (_, i) => `${i}:${line}`).join("\n") + "\n", "utf8");
    expect(statSync(path).size).toBeGreaterThan(rotateAt);

    appendLine(path, "after", rotateAt, keep);

    expect(statSync(path).size).toBeLessThan(rotateAt / 2 + line.length + 16);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThan(keep);
    expect(lines.at(-1)).toBe("after");
    expect(lines.at(-2)).toBe(`${keep - 1}:${line}`);
  });

  test("short lines are cut by the line cap alone", () => {
    const path = join(dir, "log");
    for (let i = 0; i < 12; i++) appendLine(path, `line ${i}`, 40, 5);
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    expect(lines.length).toBeLessThanOrEqual(6);
    expect(lines.at(-1)).toBe("line 11");
  });
});
