import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { closeState } from "../src/index.ts";
import { legacyWorlds } from "../src/stores.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-stores-"));
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

const touch = (path: string): void => writeFileSync(path, "{}");

describe("legacyWorlds", () => {
  test("refine attempts: a plain file and a claim count, a backup does not; dot names are skipped", () => {
    const dir = join(paths.stateDir(), "curriculum", "refine-attempts");
    mkdirSync(dir, { recursive: true });
    touch(join(dir, "beta.json"));
    touch(join(dir, "alpha.json.importing"));
    touch(join(dir, "gamma.json.imported-20261025-3"));
    touch(join(dir, ".hidden.json"));
    touch(join(dir, "beta.json.importing"));
    // NFD on disk reads back as the NFC world name.
    touch(join(dir, `${"Koleżka"}.json`));
    expect(legacyWorlds("refine_attempts")).toEqual(["Koleżka", "alpha", "beta"].sort());
  });

  test("aliases: world dirs holding aliases.json or its claim, nothing else", () => {
    const worlds = join(paths.dataDir(), "worlds");
    for (const w of ["a", "b", "c", ".dot"]) mkdirSync(join(worlds, w), { recursive: true });
    touch(join(worlds, "a", "aliases.json"));
    touch(join(worlds, "b", "aliases.json.importing"));
    touch(join(worlds, "c", "aliases.json.imported-1-1"));
    touch(join(worlds, ".dot", "aliases.json"));
    expect(legacyWorlds("aliases")).toEqual(["a", "b"]);
  });

  test("a missing directory is no worlds", () => {
    expect(legacyWorlds("refine_attempts")).toEqual([]);
    expect(legacyWorlds("aliases")).toEqual([]);
  });

  test("a directory that cannot be listed throws", () => {
    // A file where the directory should be: readdir fails with ENOTDIR, not ENOENT.
    mkdirSync(paths.dataDir(), { recursive: true });
    touch(join(paths.dataDir(), "worlds"));
    expect(() => legacyWorlds("aliases")).toThrow();
  });
});
