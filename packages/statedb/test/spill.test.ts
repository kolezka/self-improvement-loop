import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listSpillSegments, spillDir, spillPending } from "../src/spill.ts";

let tmp: string;
let legacy: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-spill-"));
  legacy = join(tmp, "w.jsonl");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("spill dir", () => {
  test("spillDir is the legacy path plus .spill", () => {
    expect(spillDir(legacy)).toBe(`${legacy}.spill`);
  });

  test("a missing dir has no segments and no claims", () => {
    expect(listSpillSegments(legacy)).toEqual({ segments: [], claims: [] });
    expect(spillPending(legacy)).toBe(false);
  });

  test("segments and claims are sorted basenames; backups are neither", () => {
    const dir = spillDir(legacy);
    mkdirSync(dir);
    for (const name of ["b-1-2.jsonl", "a-1-1.jsonl", "c-1-3.jsonl.importing", "a-1-0.jsonl.imported-20261026-4"]) writeFileSync(join(dir, name), "{}\n");
    expect(listSpillSegments(legacy)).toEqual({ segments: ["a-1-1.jsonl", "b-1-2.jsonl"], claims: ["c-1-3.jsonl.importing"] });
    expect(spillPending(legacy)).toBe(true);
  });

  test("an empty dir or one with backups only is not pending; a claim alone is", () => {
    const dir = spillDir(legacy);
    mkdirSync(dir);
    expect(spillPending(legacy)).toBe(false);
    writeFileSync(join(dir, "x.jsonl.imported-1"), "{}\n");
    expect(spillPending(legacy)).toBe(false);
    writeFileSync(join(dir, "y.jsonl.importing"), "{}\n");
    expect(spillPending(legacy)).toBe(true);
  });

  test("a spill path that is a file throws instead of reading as empty", () => {
    writeFileSync(spillDir(legacy), "not a dir");
    expect(() => listSpillSegments(legacy)).toThrow();
    expect(() => spillPending(legacy)).toThrow();
  });
});
