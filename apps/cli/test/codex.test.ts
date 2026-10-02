import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { run } from "../src/main.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const SOURCE_SKILL = join(REPO_ROOT, "skills", "self-improvement-loop", "SKILL.md");
const ENV_KEYS = ["HOME", "PATH", "CLAUDE_PLUGIN_ROOT", "SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"];

let tmp: string;
let out: string[];
let warned: string[];
const saved: Record<string, string | undefined> = {};
const realLog = console.log;
const realWarn = console.warn;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-cli-codex-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env["HOME"] = join(tmp, "home");
  process.env["CLAUDE_PLUGIN_ROOT"] = REPO_ROOT;
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) process.env[k] = join(tmp, k.toLowerCase());

  out = [];
  warned = [];
  console.log = (...args: unknown[]) => {
    out.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    warned.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.log = realLog;
  console.warn = realWarn;
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

const installedSkill = (): string => join(tmp, "home", ".agents", "skills", "self-improvement-loop", "SKILL.md");
const installedShim = (): string => join(tmp, "home", ".local", "bin", "sil");

describe("sil codex install", () => {
  test("copies the same skill Claude Code loads into ~/.agents/skills and writes the sil shim", async () => {
    expect(await run(["codex", "install"])).toBe(0);

    expect(readFileSync(installedSkill(), "utf8")).toBe(readFileSync(SOURCE_SKILL, "utf8"));
    expect(readFileSync(installedShim(), "utf8")).toBe(readFileSync(join(REPO_ROOT, "scripts", "sil"), "utf8"));
    expect(statSync(installedShim()).mode & 0o111).not.toBe(0);
    expect(out.join("\n")).toContain(installedSkill());
  });

  test("re-running replaces a stale copy", async () => {
    mkdirSync(dirname(installedSkill()), { recursive: true });
    writeFileSync(installedSkill(), "---\nname: self-improvement-loop\ndescription: old\n---\n", "utf8");

    expect(await run(["codex", "install"])).toBe(0);
    expect(readFileSync(installedSkill(), "utf8")).toBe(readFileSync(SOURCE_SKILL, "utf8"));
  });

  test("never writes through a symlink the user put at either destination", async () => {
    const checkoutSkill = join(tmp, "checkout", "skills", "self-improvement-loop");
    mkdirSync(checkoutSkill, { recursive: true });
    writeFileSync(join(checkoutSkill, "SKILL.md"), "checkout copy\n", "utf8");
    mkdirSync(dirname(dirname(installedSkill())), { recursive: true });
    symlinkSync(checkoutSkill, dirname(installedSkill()));

    const otherShim = join(tmp, "checkout", "scripts", "sil");
    mkdirSync(dirname(otherShim), { recursive: true });
    writeFileSync(otherShim, "#!/bin/sh\necho checkout\n", "utf8");
    mkdirSync(dirname(installedShim()), { recursive: true });
    symlinkSync(otherShim, installedShim());

    expect(await run(["codex", "install"])).toBe(0);
    expect(readFileSync(join(checkoutSkill, "SKILL.md"), "utf8")).toBe("checkout copy\n");
    expect(readFileSync(otherShim, "utf8")).toBe("#!/bin/sh\necho checkout\n");
    expect(out.join("\n")).toContain("symlink");
  });

  test("warns only when the shim directory is not on PATH", async () => {
    process.env["PATH"] = "/usr/bin";
    expect(await run(["codex", "install"])).toBe(0);
    expect(warned.join("\n")).toContain(dirname(installedShim()));

    warned = [];
    process.env["PATH"] = [dirname(installedShim()), "/usr/bin"].join(delimiter);
    expect(await run(["codex", "install"])).toBe(0);
    expect(warned).toEqual([]);
  });
});
