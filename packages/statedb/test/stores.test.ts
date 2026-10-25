import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { closeState } from "../src/index.ts";
import { legacyWorlds, legacyWorldsReport } from "../src/stores.ts";

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
  test("both stores report raw invalid names and only return path-safe worlds", () => {
    const refine = join(paths.stateDir(), "curriculum", "refine-attempts");
    const aliases = join(paths.dataDir(), "worlds");
    mkdirSync(refine, { recursive: true });
    for (const world of ["a_b", "a b"]) {
      touch(join(refine, `${world}.json`));
      mkdirSync(join(aliases, world), { recursive: true });
      touch(join(aliases, world, "aliases.json.importing"));
    }
    for (const store of ["refine_attempts", "aliases"] as const) {
      expect(legacyWorldsReport(store)).toEqual({ worlds: ["a_b"], invalid: ["a b"] });
      expect(legacyWorlds(store)).toEqual(["a_b"]);
    }
  });

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

  test.skipIf(process.getuid?.() === 0)("aliases: a world dir that cannot be inspected throws, not reads as no aliases", () => {
    const worlds = join(paths.dataDir(), "worlds");
    for (const w of ["known", "private"]) {
      mkdirSync(join(worlds, w), { recursive: true });
      touch(join(worlds, w, "aliases.json"));
    }
    // Positive control: both worlds are found while readable.
    expect(legacyWorlds("aliases")).toEqual(["known", "private"]);
    chmodSync(join(worlds, "private"), 0o000);
    try {
      let error: unknown = null;
      try {
        legacyWorlds("aliases");
      } catch (e) {
        error = e;
      }
      expect((error as NodeJS.ErrnoException | null)?.code).toBe("EACCES");
    } finally {
      chmodSync(join(worlds, "private"), 0o755);
    }
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
