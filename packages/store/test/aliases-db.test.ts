// Aliases live in the loop-state database. saveAliases writes rows, both
// loaders read them, and a legacy aliases.json is imported once and backed up.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths, StateReadError, ValidationError } from "@sil/core";
import { closeState } from "@sil/statedb";
import { loadAliases, loadAliasesStrict, saveAliases } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-aliases-db-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

const seedLegacy = (world: string, text: string): string => {
  const file = paths.aliasesFile(world);
  fsx.ensureDir(dirname(file));
  writeFileSync(file, text);
  return file;
};

const backups = (file: string): string[] =>
  readdirSync(dirname(file)).filter((name) => name.startsWith(`${basename(file)}.imported-`));

describe("aliases on the loop-state database", () => {
  test("saveAliases writes rows, not the legacy file, and returns the database path", () => {
    const written = saveAliases("default", { old: "new" });
    expect(existsSync(paths.aliasesFile("default"))).toBe(false);
    expect(written).toBe(paths.loopStateDb());
    expect(loadAliases("default")).toEqual({ old: "new" });
    expect(loadAliasesStrict("default")).toEqual({ old: "new" });
  });

  test("a legacy aliases.json reads back through both loaders and becomes a backup", () => {
    const file = seedLegacy("default", JSON.stringify({ old: "new" }));
    expect(loadAliasesStrict("default")).toEqual({ old: "new" });
    expect(loadAliases("default")).toEqual({ old: "new" });
    expect(existsSync(file)).toBe(false);
    expect(backups(file)).toHaveLength(1);
  });

  test("a chain is refused with the one-hop message and the stored aliases stay", () => {
    saveAliases("default", { old: "new" });
    const error = caught(() => saveAliases("default", { a: "b", b: "c" }));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as Error).message).toBe('"b" is a key (-> "c") and also the value of "a" (-> "b"); aliases resolve one hop only');
    expect(loadAliases("default")).toEqual({ old: "new" });
  });

  test("a legacy chained file is quarantined: tolerant reads empty, strict raises", () => {
    seedLegacy("default", JSON.stringify({ a: "b", b: "c" }));
    expect(loadAliases("default")).toEqual({});
    const error = caught(() => loadAliasesStrict("default"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toContain("could not be imported");
    expect((error as Error).message).toContain('the aliases of world "default"');
  });

  test("an NFD world name reads the aliases saved under its NFC form", () => {
    saveAliases("koleżka", { a: "b" });
    expect(loadAliases("koleżka".normalize("NFD"))).toEqual({ a: "b" });
    expect(loadAliasesStrict("koleżka".normalize("NFD"))).toEqual({ a: "b" });
  });
});
