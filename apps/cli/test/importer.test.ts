import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { Config, ledgerPath, paths, World } from "@sil/core";
import { loadLedger } from "@sil/store";
import { importKbWorlds, importLedger, importReflections, mergeWorlds } from "../src/importer.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-importer-"));
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

describe("importReflections", () => {
  test("copies only files with a Pattern line, skips the rest", () => {
    const src = join(tmp, "mirror");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "one.md"), "---\nid: one\n---\nPattern: foo-bar\n\nbody\n");
    writeFileSync(join(src, "two.md"), "Pattern: baz-qux\n\nanother body\n");
    writeFileSync(join(src, "README.md"), "# not a reflection, no pattern line\n");

    const result = importReflections(src, "default");
    expect(result).toEqual({ copied: 2, skippedDuplicate: 0, skippedNonReflection: 1 });

    const destFiles = readdirSync(paths.reflectionsDir("default")).sort();
    expect(destFiles).toEqual(["one.md", "two.md"]);
  });

  test("skips duplicates on rerun", () => {
    const src = join(tmp, "mirror");
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, "one.md"), "Pattern: foo-bar\n\nbody\n");

    const first = importReflections(src, "default");
    const second = importReflections(src, "default");
    expect(first.copied).toBe(1);
    expect(second.copied).toBe(0);
    expect(second.skippedDuplicate).toBe(1);
  });
});

describe("importLedger", () => {
  test("maps a V1 list shaped promotions.json", () => {
    const src = join(tmp, "promotions.json");
    writeFileSync(
      src,
      JSON.stringify([
        { pattern: "foo-bar", promoted_at_count: 3, status: "promoted", last_updated: "2026-01-01" },
        { pattern: "baz-qux", status: "staged", last_updated: "2026-01-02" },
      ]),
    );
    const world = World.parse({ name: "default", target: join(tmp, "target") });

    const count = importLedger(src, world);
    expect(count).toBe(2);

    const ledger = loadLedger(ledgerPath(world));
    expect(new Set(Object.keys(ledger.entries))).toEqual(new Set(["foo-bar", "baz-qux"]));
    expect(ledger.entries["foo-bar"]!.promoted_at_count).toBe(3);
    expect(ledger.entries["foo-bar"]!.status).toBe("promoted");
  });
});

describe("importKbWorlds and mergeWorlds", () => {
  test("reads a V1 kb worlds.yaml manifest into repos", () => {
    const manifest = join(tmp, "worlds.yaml");
    writeFileSync(
      manifest,
      YAML.stringify({
        worlds: [
          { name: "raqz", llm: "cloud", projects: [{ name: "dotfiles", repo: join(tmp, "dotfiles") }] },
          { name: "client-a", projects: [{ repo: join(tmp, "client-a") }] },
        ],
      }),
    );

    const worlds = importKbWorlds(manifest);
    expect(worlds.map((w) => w.name)).toEqual(["raqz", "client-a"]);
    expect(worlds[0]!.llm).toBe("cloud");
    expect(worlds[0]!.repos).toEqual([join(tmp, "dotfiles")]);
    expect(worlds[1]!.llm).toBe("cloud");
    expect(worlds[0]!.target).toBeNull();
  });

  test("merge adds only new names", () => {
    const cfg = Config.parse({ worlds: [World.parse({ name: "default" })] });
    const imported = [World.parse({ name: "default" }), World.parse({ name: "raqz" })];
    const added = mergeWorlds(cfg, imported);
    expect(added).toBe(1);
    expect(new Set(cfg.worlds.map((w) => w.name))).toEqual(new Set(["default", "raqz"]));
  });
});
