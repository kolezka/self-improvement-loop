// Keeps scripts/bench-reflection-index.ts from rotting: three seeded
// reflection files, a tiny n, and the rows the script promises.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { run } from "../scripts/bench-reflection-index.ts";

// The shape writeReflection writes, so the strict reader accepts it.
const reflection = (id: string): string =>
  `---\nid: ${id}\nworld: default\npattern: bench-${id}\ncreated: 2026-10-26\ncreated_at: 2026-10-26T00:00:00.000Z\n---\nPattern: bench-${id}\n\n## Reusable lesson\nx\n`;

let src: string;

beforeEach(() => {
  src = mkdtempSync(join(tmpdir(), "sil-bench-index-src-"));
  mkdirSync(src, { recursive: true });
  for (const id of ["a1", "b2", "c3"]) writeFileSync(join(src, `${id}.md`), reflection(id));
});

afterEach(() => {
  rmSync(src, { recursive: true, force: true });
});

describe("reflections index bench", () => {
  test("run times both readers and leaves the source dir as it was", async () => {
    const before = readdirSync(src).sort().map((f) => [f, readFileSync(join(src, f), "utf8")]);
    const rows = await run(src, 2);
    expect(rows.map((r) => r.name)).toEqual(["listReflections", "listReflectionHeads cold", "listReflectionHeads warm"]);
    for (const row of rows) {
      expect(row.n).toBe(row.name === "listReflectionHeads cold" ? 1 : 2);
      // Positive control: every call read the three seeded records.
      expect(row.records).toBe(3);
      expect(row.p50).toBeGreaterThanOrEqual(0);
      expect(row.max).toBeGreaterThanOrEqual(row.p50);
    }
    expect(readdirSync(src).sort().map((f) => [f, readFileSync(join(src, f), "utf8")])).toEqual(before);
  }, 30_000);
});
