import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, type HumanFeedback, loadConfig, StateReadError } from "@sil/core";
import { listHuman } from "@sil/feedback";
import { loadAliases, loadAliasesStrict, saveAliases } from "@sil/store";
import { appendRecord, closeState, openState, readRecords } from "@sil/statedb";
import { exportBundle, humanBytes, importBundle, isArchivePath, portableConfig } from "../src/bundle.ts";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

function useRoots(prefix: string): void {
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    process.env[k] = join(tmp, prefix, k.toLowerCase());
  }
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-bundle-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) saved[k] = process.env[k];
  useRoots("hostA");
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

describe("pure helpers", () => {
  test("isArchivePath only matches tar.gz and tgz", () => {
    expect(isArchivePath("/tmp/b.tar.gz")).toBe(true);
    expect(isArchivePath("/tmp/b.TGZ")).toBe(true);
    expect(isArchivePath("/tmp/bundle")).toBe(false);
    expect(isArchivePath("/tmp/b.tar")).toBe(false);
  });

  test("portableConfig rewrites paths under home and leaves the rest alone", () => {
    const cfg = Config.parse({
      worlds: [
        {
          name: "default",
          repos: ["/home/tester/code/app", "/srv/shared"],
          target: "/home/tester/dotfiles",
          llm_config: "/home/tester/.config/x.yaml",
        },
      ],
    });
    const out = portableConfig(cfg, "/home/tester");
    expect(out.worlds[0]!.repos).toEqual(["~/code/app", "/srv/shared"]);
    expect(out.worlds[0]!.target).toBe("~/dotfiles");
    expect(out.worlds[0]!.llm_config).toBe("~/.config/x.yaml");
  });

  test("humanBytes scales past a kilobyte", () => {
    expect(humanBytes(512)).toBe("512 B");
    expect(humanBytes(2048)).toBe("2.0 KB");
    expect(humanBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("sil export", () => {
  test("writes a manifest plus the world's reflections into a directory", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    writeFileSync(join(paths.reflectionsDir("default"), "r1.md"), "Pattern: x\n");

    const dest = join(tmp, "bundle");
    const result = exportBundle({ dest });

    expect(result.archive).toBe(false);
    expect(result.files).toBeGreaterThan(0);
    const manifest = JSON.parse(readFileSync(join(dest, "manifest.json"), "utf8"));
    expect(manifest.version).toBe(1);
    expect(manifest.worlds.map((w: { name: string }) => w.name)).toEqual(["default"]);
    expect(existsSync(join(dest, "config", "config.yaml"))).toBe(true);
    expect(existsSync(join(dest, "config", "llm.yaml"))).toBe(true);
    expect(readFileSync(join(dest, "worlds", "default", "reflections", "r1.md"), "utf8")).toBe("Pattern: x\n");
  });

  test("never copies a secrets file that sits next to config.yaml", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    writeFileSync(join(paths.configDir(), "env"), "LITELLM_API_KEY=secret\n");

    const dest = join(tmp, "bundle");
    exportBundle({ dest });

    expect(existsSync(join(dest, "config", "env"))).toBe(false);
    expect(readFileSync(join(dest, "config", "llm.yaml"), "utf8")).not.toContain("secret");
  });

  test("--world exports only the named world and refuses an unknown one", async () => {
    expect(await run(["init"])).toBe(0);
    expect(await run(["worlds", "add", "raqz"])).toBe(0);

    const dest = join(tmp, "bundle");
    const result = exportBundle({ dest, worlds: ["raqz"] });

    expect(result.manifest.worlds.map((w) => w.name)).toEqual(["raqz"]);
    expect(existsSync(join(dest, "worlds", "default"))).toBe(false);
    expect(() => exportBundle({ dest: join(tmp, "other"), worlds: ["nope"] })).toThrow(/unknown world/);
  });

  test("refuses a non-empty destination unless --force is given", async () => {
    expect(await run(["init"])).toBe(0);
    const dest = join(tmp, "bundle");
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, "keep.txt"), "mine\n");

    expect(() => exportBundle({ dest })).toThrow(/already exists/);
    exportBundle({ dest, force: true });
    expect(existsSync(join(dest, "keep.txt"))).toBe(false);
    expect(existsSync(join(dest, "manifest.json"))).toBe(true);
  });

  test("--no-history leaves usage and feedback behind", async () => {
    expect(await run(["init"])).toBe(0);
    const { fsx, paths } = await import("@sil/core");
    fsx.appendJsonl(paths.usageEventsFile(), { kind: "use" });

    const dest = join(tmp, "bundle");
    const result = exportBundle({ dest, history: false });

    expect(result.manifest.history).toBe(false);
    expect(existsSync(join(dest, "state", "usage", "events.jsonl"))).toBe(false);
  });
});

describe("sil import bundle", () => {
  test("restores config, worlds and reflections onto an empty host", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    expect(await run(["worlds", "add", "raqz"])).toBe(0);
    mkdirSync(paths.reflectionsDir("raqz"), { recursive: true });
    writeFileSync(join(paths.reflectionsDir("raqz"), "r1.md"), "Pattern: x\n");

    const dest = join(tmp, "bundle");
    exportBundle({ dest });

    useRoots("hostB");
    const result = importBundle({ src: dest });

    expect(result.worlds).toEqual(["default", "raqz"]);
    const cfg = loadConfig();
    expect(cfg.worlds.map((w) => w.name).sort()).toEqual(["default", "raqz"]);
    expect(readFileSync(join(paths.reflectionsDir("raqz"), "r1.md"), "utf8")).toBe("Pattern: x\n");
    expect(existsSync(paths.llmFile())).toBe(true);
    expect(existsSync(paths.hookSnapshotFile())).toBe(true);
  });

  test("a tar.gz bundle round trips the built-in learned repo", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths, loadConfig: load, targetRoot } = await import("@sil/core");
    const source = targetRoot(load().worlds[0]!);
    writeFileSync(join(source, "RULES.md"), "# rules\n");

    const archive = join(tmp, "sil.tar.gz");
    const exported = exportBundle({ dest: archive });
    expect(exported.archive).toBe(true);
    expect(existsSync(archive)).toBe(true);

    useRoots("hostB");
    const result = importBundle({ src: archive });
    expect(result.archive).toBe(true);
    const restored = targetRoot(load().worlds[0]!);
    expect(readFileSync(join(restored, "RULES.md"), "utf8")).toBe("# rules\n");
    expect(existsSync(join(restored, ".git"))).toBe(true);
    expect(existsSync(paths.queueDir("pending"))).toBe(true);
  });

  test("a file the host already has survives, unless --force", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    writeFileSync(paths.scorecardsFile("default"), '{"from":"bundle"}');
    const dest = join(tmp, "bundle");
    exportBundle({ dest });

    useRoots("hostB");
    expect(await run(["init"])).toBe(0);
    writeFileSync(paths.scorecardsFile("default"), '{"from":"host"}');

    const kept = importBundle({ src: dest });
    expect(kept.skipped).toBeGreaterThan(0);
    expect(readFileSync(paths.scorecardsFile("default"), "utf8")).toBe('{"from":"host"}');

    importBundle({ src: dest, force: true });
    expect(readFileSync(paths.scorecardsFile("default"), "utf8")).toBe('{"from":"bundle"}');
  });

  test("refuses a directory with no manifest and a bundle from a newer sil", async () => {
    const plain = join(tmp, "plain");
    mkdirSync(plain, { recursive: true });
    expect(() => importBundle({ src: plain })).toThrow(/not a sil bundle/);
    expect(() => importBundle({ src: join(tmp, "gone") })).toThrow(/no such bundle/);

    writeFileSync(join(plain, "manifest.json"), JSON.stringify({ version: 99, created_at: "now", worlds: [] }));
    expect(() => importBundle({ src: plain })).toThrow(/version 99 is not supported/);
  });
});

describe("feedback logs in loop state", () => {
  const human: HumanFeedback[] = [
    { ts: "2026-10-25T10:00:00Z", world: "default", ref: "skill:a", vote: "good", note: "", session_id: null },
    { ts: "2026-10-25T09:00:00Z", world: "default", ref: "skill:b", vote: "bad", note: "older ts, appended later", session_id: "s1" },
  ];
  const critic = [{ ts: "2026-10-25T08:00:00Z", world: "default", ref: "rule:c", verdict: "misfire" }];
  const lines = (records: object[]): string => records.map((r) => `${JSON.stringify(r)}\n`).join("");

  async function exportFromHostA(): Promise<string> {
    expect(await run(["init"])).toBe(0);
    for (const r of human) appendRecord("human", r);
    for (const r of critic) appendRecord("critic", r);
    const dest = join(tmp, "bundle");
    exportBundle({ dest });
    return dest;
  }

  test("export with history writes each log's bodies in append order", async () => {
    const dest = await exportFromHostA();
    expect(readFileSync(join(dest, "state", "feedback", "human.jsonl"), "utf8")).toBe(lines(human));
    expect(readFileSync(join(dest, "state", "feedback", "critic.jsonl"), "utf8")).toBe(lines(critic));
  });

  test("import onto an empty host makes the bundle's records readable", async () => {
    const dest = await exportFromHostA();
    useRoots("hostB");
    const result = importBundle({ src: dest });
    expect(result.warnings.filter((w) => w.includes("could not be imported"))).toEqual([]);
    expect(listHuman()).toEqual(human);
    expect(readRecords("critic", "strict").records).toEqual(critic);
  });

  test("a host that has rows keeps them and reports a skip, unless --force", async () => {
    const dest = await exportFromHostA();
    useRoots("hostC");
    expect(await run(["init"])).toBe(0);
    const baseline = importBundle({ src: dest });

    useRoots("hostB");
    expect(await run(["init"])).toBe(0);
    const own: HumanFeedback = { ts: "2026-10-24T00:00:00Z", world: "default", ref: "skill:host", vote: "good", note: "", session_id: null };
    appendRecord("human", own);
    const kept = importBundle({ src: dest });
    expect(listHuman()).toEqual([own]);
    expect(readRecords("critic", "strict").records).toEqual(critic);
    expect(kept.skipped - baseline.skipped).toBe(1);
    expect(baseline.files - kept.files).toBe(1);

    importBundle({ src: dest, force: true });
    expect(listHuman()).toEqual(human);
    expect(readRecords("critic", "strict").records).toEqual(critic);
  });

  test("a bad line in a bundle file is quarantined and the good lines import", async () => {
    const dest = await exportFromHostA();
    const file = join(dest, "state", "feedback", "human.jsonl");
    writeFileSync(file, `${lines(human)}not json\n`);

    useRoots("hostB");
    const result = importBundle({ src: dest });
    expect(result.warnings).toContain("human.jsonl: 1 line could not be imported; see sil state quarantine");
    expect(result.warnings.filter((w) => w.includes("could not be imported"))).toHaveLength(1);
    expect(readRecords("human", "counted")).toEqual({ records: human, quarantined: 1 });
    const rows = openState().query("SELECT store, source, line_no, reason, raw FROM quarantine").all();
    expect(rows).toEqual([{ store: "human", source: file, line_no: 3, reason: "not JSON", raw: "not json" }]);
  });

  test("export refuses a log with quarantined lines and writes no bundle", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    appendRecord("human", human[0]!);
    // A legacy critic file with a bad line: the export's import quarantines it.
    writeFileSync(paths.criticFeedbackFile(), `${lines(critic)}garbage\n`);

    const dir = join(tmp, "bundle");
    expect(() => exportBundle({ dest: dir })).toThrow("the critic feedback log has 1 quarantined line; see sil state quarantine");
    expect(existsSync(dir)).toBe(false);
    const archive = join(tmp, "sil.tar.gz");
    expect(() => exportBundle({ dest: archive })).toThrow("the critic feedback log has 1 quarantined line; see sil state quarantine");
    expect(existsSync(archive)).toBe(false);
  });
});

describe("aliases in loop state", () => {
  async function exportAliasesFromHostA(): Promise<string> {
    expect(await run(["init"])).toBe(0);
    saveAliases("default", { old: "new" });
    const dest = join(tmp, "bundle");
    exportBundle({ dest });
    return dest;
  }

  test("export writes the world's map as sorted two-space JSON", async () => {
    expect(await run(["init"])).toBe(0);
    saveAliases("default", { zeta: "zed", alpha: "first" });
    const dest = join(tmp, "bundle");
    exportBundle({ dest });
    const text = readFileSync(join(dest, "worlds", "default", "aliases.json"), "utf8");
    expect(text).toBe(`${JSON.stringify({ alpha: "first", zeta: "zed" }, null, 2)}\n`);
    expect(text).not.toBe(`${JSON.stringify({ zeta: "zed", alpha: "first" }, null, 2)}\n`);
  });

  test("export writes no aliases file for a world with no aliases", async () => {
    expect(await run(["init"])).toBe(0);
    const dest = join(tmp, "bundle");
    exportBundle({ dest });
    expect(existsSync(join(dest, "manifest.json"))).toBe(true);
    expect(existsSync(join(dest, "worlds", "default", "aliases.json"))).toBe(false);
  });

  test("import onto an empty host makes the bundle's aliases readable", async () => {
    const dest = await exportAliasesFromHostA();
    useRoots("hostB");
    importBundle({ src: dest });
    expect(loadAliases("default")).toEqual({ old: "new" });
  });

  test("a host with aliases keeps them and reports a skip, unless --force", async () => {
    const dest = await exportAliasesFromHostA();
    useRoots("hostC");
    expect(await run(["init"])).toBe(0);
    const baseline = importBundle({ src: dest });
    expect(loadAliases("default")).toEqual({ old: "new" });

    useRoots("hostB");
    expect(await run(["init"])).toBe(0);
    saveAliases("default", { mine: "host" });
    const kept = importBundle({ src: dest });
    expect(loadAliases("default")).toEqual({ mine: "host" });
    expect(kept.skipped - baseline.skipped).toBe(1);
    expect(baseline.files - kept.files).toBe(1);

    importBundle({ src: dest, force: true });
    expect(loadAliases("default")).toEqual({ old: "new" });
  });

  test("a chained bundle map is a one-hop warning and leaves the host map alone", async () => {
    const dest = await exportAliasesFromHostA();
    writeFileSync(join(dest, "worlds", "default", "aliases.json"), `${JSON.stringify({ a: "b", b: "c" }, null, 2)}\n`);
    useRoots("hostB");
    expect(await run(["init"])).toBe(0);
    saveAliases("default", { mine: "host" });

    const result = importBundle({ src: dest, force: true });
    const warned = result.warnings.filter((w) => w.startsWith("aliases.json (world default): not imported ("));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain("one hop");
    expect(loadAliases("default")).toEqual({ mine: "host" });
  });

  for (const [kind, body] of [
    ["chained", `${JSON.stringify({ a: "b", b: "c" }, null, 2)}\n`],
    ["bad JSON", "not json"],
  ] as const) {
    test(`a ${kind} bundle map warns even when the host has aliases and no --force`, async () => {
      const dest = await exportAliasesFromHostA();
      writeFileSync(join(dest, "worlds", "default", "aliases.json"), body);
      // Baseline: a host with no aliases, where the file is never a skip either.
      useRoots("hostC");
      expect(await run(["init"])).toBe(0);
      const baseline = importBundle({ src: dest });

      useRoots("hostB");
      expect(await run(["init"])).toBe(0);
      saveAliases("default", { x: "y" });
      const result = importBundle({ src: dest });
      const warned = result.warnings.filter((w) => w.startsWith("aliases.json (world default): not imported ("));
      expect(warned).toHaveLength(1);
      expect(warned[0]).toContain(kind === "chained" ? "one hop" : "not JSON");
      expect(result.skipped).toBe(baseline.skipped);
      expect(loadAliases("default")).toEqual({ x: "y" });
    });
  }

  test("a bundle aliases file that is not a map of names is a warning, not a write", async () => {
    const dest = await exportAliasesFromHostA();
    const file = join(dest, "worlds", "default", "aliases.json");
    useRoots("hostB");
    for (const body of ["not json", '["a"]', '{"a":1}', '{"Not A Slug":"b"}']) {
      writeFileSync(file, body);
      const result = importBundle({ src: dest, force: true });
      expect(result.warnings.filter((w) => w.startsWith("aliases.json (world default): not imported ("))).toHaveLength(1);
      expect(loadAliasesStrict("default")).toEqual({});
    }
  });

  test("export refuses a quarantined aliases store and writes no bundle", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    // A legacy aliases file that is not a map: the strict read quarantines it.
    writeFileSync(paths.aliasesFile("default"), "not json");
    const dir = join(tmp, "bundle");
    expect(() => exportBundle({ dest: dir })).toThrow(StateReadError);
    expect(existsSync(dir)).toBe(false);
  });
});

describe("the CLI surface", () => {
  test("sil export then sil import bundle move an install between hosts", async () => {
    expect(await run(["init"])).toBe(0);
    const { paths } = await import("@sil/core");
    writeFileSync(join(paths.reflectionsDir("default"), "r1.md"), "Pattern: x\n");

    const archive = join(tmp, "sil.tar.gz");
    expect(await run(["export", archive])).toBe(0);

    useRoots("hostB");
    expect(await run(["import", "bundle", archive])).toBe(0);
    expect(readFileSync(join(paths.reflectionsDir("default"), "r1.md"), "utf8")).toBe("Pattern: x\n");

    // A second export over the same archive needs --force.
    useRoots("hostA");
    expect(await run(["export", archive])).toBe(1);
    expect(await run(["export", archive, "--force"])).toBe(0);
  });

  test("both commands print a summary and remind the operator about credentials", async () => {
    expect(await run(["init"])).toBe(0);
    const dest = join(tmp, "bundle");

    const lines: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(args.join(" "));
    });
    try {
      expect(await run(["export", dest])).toBe(0);
      const exported = lines.join("\n");
      expect(exported).toContain(dest);
      expect(exported).toContain("world default:");
      expect(exported).toContain("No credentials are in the bundle");

      lines.length = 0;
      useRoots("hostB");
      expect(await run(["import", "bundle", dest])).toBe(0);
      const restored = lines.join("\n");
      expect(restored).toContain("worlds: default");
      expect(restored).toMatch(/restored \d+ files/);
    } finally {
      spy.mockRestore();
    }
  });
});
