// console.bootstrap: which worlds exist and which one owns the session's cwd,
// resolved by the same worldForCwd rules the hooks use. Read only: a missing
// config is reported, never created, and no world is guessed.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import "../src/index.ts";
import { CONTROL_READ_OPS, executeControlRead } from "../src/control.ts";
import { consoleBootstrap } from "../src/handlers/console.ts";
import { invoke, REGISTRY } from "../src/registry.ts";

let root: string;
let configDir: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["HOME", "SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"] as const;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "sil-console-")));
  configDir = join(root, "config");
  for (const name of ENV) saved[name] = process.env[name];
  process.env.HOME = join(root, "home");
  process.env.SIL_CONFIG_DIR = configDir;
  process.env.SIL_STATE_DIR = join(root, "state");
  process.env.SIL_DATA_DIR = join(root, "data");
  for (const dir of ["home", "repos/alpha/sub/deep", "repos/beta", "elsewhere"]) mkdirSync(join(root, dir), { recursive: true });
});

afterEach(() => {
  for (const name of ENV) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
  rmSync(root, { recursive: true, force: true });
});

function writeConfig(yaml: string): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, "config.yaml"), yaml);
}

function worlds(lines: string[]): string {
  return `worlds:\n${lines.join("\n")}\n`;
}

describe("console.bootstrap", () => {
  test("the longest repos prefix owns the cwd", () => {
    writeConfig(
      worlds([
        "  - name: wide",
        `    repos: ["${root}/repos"]`,
        "  - name: alpha",
        `    repos: ["${root}/repos/alpha"]`,
        "  - name: everything",
        "    repos: []",
      ]),
    );
    expect(consoleBootstrap({ cwd: join(root, "repos/alpha/sub/deep") })).toEqual({
      worlds: ["wide", "alpha", "everything"],
      selectedWorld: "alpha",
      resolutionError: null,
      initialized: true,
    });
    expect(consoleBootstrap({ cwd: join(root, "repos/beta") }).selectedWorld).toBe("wide");
  });

  test("a cwd no repos list owns falls to the first catch-all world", () => {
    writeConfig(
      worlds([
        "  - name: alpha",
        `    repos: ["${root}/repos/alpha"]`,
        "  - name: first-catch",
        "  - name: second-catch",
      ]),
    );
    expect(consoleBootstrap({ cwd: join(root, "elsewhere") })).toEqual({
      worlds: ["alpha", "first-catch", "second-catch"],
      selectedWorld: "first-catch",
      resolutionError: null,
      initialized: true,
    });
  });

  test("no owner and no catch-all is a visible error, never the first world", () => {
    writeConfig(worlds(["  - name: alpha", `    repos: ["${root}/repos/alpha"]`, "  - name: beta", `    repos: ["${root}/repos/beta"]`]));
    const result = consoleBootstrap({ cwd: join(root, "elsewhere") });
    expect(result.initialized).toBe(true);
    expect(result.worlds).toEqual(["alpha", "beta"]);
    expect(result.selectedWorld).toBeNull();
    expect(result.resolutionError).toContain("no world owns");
  });

  test("a missing config is reported as not set up and nothing is written", () => {
    const before = readdirSync(root).sort();
    const result = consoleBootstrap({ cwd: join(root, "elsewhere") });
    expect(result).toEqual({
      worlds: [],
      selectedWorld: null,
      resolutionError: expect.stringContaining("sil init"),
      initialized: false,
    });
    // Not even the config directory: no defaults, no invented world.
    expect(existsSync(configDir)).toBe(false);
    expect(readdirSync(root).sort()).toEqual(before);
  });

  test("an invalid config throws the ConfigError, not an empty success", () => {
    writeConfig("worlds: [ {name: 'Bad Name!'} ]\n");
    // A fixed message: the console shows it, so no path and no raw value.
    expect(() => consoleBootstrap({ cwd: join(root, "elsewhere") })).toThrow(/^config\.yaml does not match the config schema \(1 problem\)$/);
  });

  test("the cwd must be a non-empty absolute path", async () => {
    writeConfig(worlds(["  - name: alpha"]));
    for (const cwd of ["", "relative/path", "./x", "/ok\0nul"]) {
      await expect(invoke("console.bootstrap", { cwd })).rejects.toThrow();
    }
    await expect(invoke("console.bootstrap", {})).rejects.toThrow();
    expect(await invoke("console.bootstrap", { cwd: root })).toMatchObject({ selectedWorld: "alpha" });
  });
});

describe("console.bootstrap in the control bridge", () => {
  test("is registered read tier and allowlisted", () => {
    expect(REGISTRY.get("console.bootstrap")?.tier).toBe("read");
    expect(CONTROL_READ_OPS).toContain("console.bootstrap");
  });

  test("answers through executeControlRead, invalid config as a per-read ConfigError", async () => {
    writeConfig(worlds(["  - name: alpha", `    repos: ["${root}/repos/alpha"]`, "  - name: catch"]));
    const ok = await executeControlRead({
      version: 1,
      requestId: "b",
      reads: [{ id: "boot", op: "console.bootstrap", args: { cwd: join(root, "repos/alpha") } }],
    });
    expect(ok.results.boot).toEqual({
      ok: true,
      value: { worlds: ["alpha", "catch"], selectedWorld: "alpha", resolutionError: null, initialized: true },
    });

    writeConfig("worlds: 7\n");
    const bad = await executeControlRead({
      version: 1,
      requestId: "b",
      reads: [{ id: "boot", op: "console.bootstrap", args: { cwd: root } }],
    });
    expect(bad.results.boot).toMatchObject({ ok: false, error: { code: "ConfigError" } });

    const relative = await executeControlRead({
      version: 1,
      requestId: "b",
      reads: [{ id: "boot", op: "console.bootstrap", args: { cwd: "repos" } }],
    });
    expect(relative.results.boot).toMatchObject({ ok: false, error: { code: "InvalidArgs" } });
  });
});
