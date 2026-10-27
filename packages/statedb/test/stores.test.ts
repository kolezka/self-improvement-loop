import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { closeState } from "../src/index.ts";
import { legacyWorlds, legacyWorldsReport, STORES } from "../src/stores.ts";

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

describe("payload samples", () => {
  test("the registry has the four hook-written streams, payload samples per world", () => {
    for (const store of ["usage_events", "nudge_fires", "hook_runs", "payload_samples"]) expect(Object.hasOwn(STORES, store)).toBe(true);
    expect({ kind: STORES.payload_samples.kind, perWorld: STORES.payload_samples.perWorld }).toEqual({ kind: "stream", perWorld: true });
    expect(STORES.payload_samples.legacyPath("inkitt").endsWith(join("usage", "payloads", "inkitt.jsonl"))).toBe(true);
    expect(STORES.payload_samples.label("inkitt")).toBe('the payload samples of world "inkitt"');
    expect(() => STORES.payload_samples.legacyPath(null)).toThrow("per-world store used without a world");
    expect(STORES.usage_events.legacyPath(null)).toBe(paths.usageEventsFile());
    expect(STORES.nudge_fires.legacyPath(null)).toBe(paths.nudgeFiresFile());
    expect(STORES.hook_runs.legacyPath(null)).toBe(paths.hookRunsFile());
    for (const store of ["usage_events", "nudge_fires", "hook_runs"] as const) {
      expect({ kind: STORES[store].kind, perWorld: STORES[store].perWorld }).toEqual({ kind: "stream", perWorld: false });
    }
    expect(STORES.usage_events.label(null)).toBe("the usage log");
    expect(STORES.nudge_fires.label(null)).toBe("the nudge fires log");
    expect(STORES.hook_runs.label(null)).toBe("the hook runs log");
  });

  test("legacyWorldsReport lists files, claims and spill dirs; backups, dot names and invalid names are not worlds", () => {
    const dir = join(paths.stateDir(), "usage", "payloads");
    mkdirSync(dir, { recursive: true });
    touch(join(dir, "default.jsonl"));
    touch(join(dir, `${"koleżka".normalize("NFD")}.jsonl`));
    touch(join(dir, "stray.jsonl.importing"));
    touch(join(dir, "old.jsonl.imported-2026-1"));
    mkdirSync(join(dir, "seg.jsonl.spill"));
    touch(join(dir, ".DS_Store"));
    touch(join(dir, "a b.jsonl"));
    expect(legacyWorldsReport("payload_samples")).toEqual({ worlds: ["default", "koleżka".normalize("NFC"), "seg", "stray"], invalid: ["a b"] });
    expect(legacyWorlds("payload_samples")).toEqual(["default", "koleżka".normalize("NFC"), "seg", "stray"]);
  });
});

describe("module load order", () => {
  test("streams.ts loads first even though stores.ts reads its table (import cycle)", () => {
    const streams = join(import.meta.dir, "..", "src", "streams.ts");
    const env = { PATH: process.env["PATH"] ?? "", HOME: tmp, SIL_CONFIG_DIR: join(tmp, "c"), SIL_STATE_DIR: join(tmp, "s"), SIL_DATA_DIR: join(tmp, "d") };
    const script = `const m = await import(${JSON.stringify(streams)}); const s = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "stores.ts"))}); console.log(Object.keys(m.STREAMS).length, s.STORES.payload_samples.perWorld);`;
    const p = Bun.spawnSync(["bun", "-e", script], { env, stdout: "pipe", stderr: "pipe" });
    expect(p.stderr.toString()).toBe("");
    expect(p.stdout.toString().trim()).toBe("8 true");
    expect(p.exitCode).toBe(0);
  });
});

describe("payload spill entries", () => {
  test("a .jsonl.spill entry names a world only when it is a directory", () => {
    const dir = join(paths.stateDir(), "usage", "payloads");
    mkdirSync(join(dir, "real.jsonl.spill"), { recursive: true });
    touch(join(dir, "stray.jsonl.spill"));
    touch(join(dir, "a b.jsonl"));
    expect(legacyWorldsReport("payload_samples")).toEqual({ worlds: ["real"], invalid: ["a b"] });
  });
});
