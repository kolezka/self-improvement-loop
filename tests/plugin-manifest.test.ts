// Plugin manifest, hooks.json, command frontmatter, skill frontmatter, and
// the repo-wide no-long-dash writing rule for plugin-facing text.

import { describe, expect, test } from "bun:test";
import { copyFileSync, globSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HOOK_EVENTS } from "../packages/core/src/consts.ts";
import { sourceFiles, sourceHash } from "../scripts/build.ts";

// Built from code points so this file passes the dash lint itself.
const EM = String.fromCodePoint(0x2014);
const EN = String.fromCodePoint(0x2013);

const ROOT = join(import.meta.dir, "..");

/** Frontmatter blocks in this repo are flat `key: value` scalars, no nesting
 * or lists, so a hand-rolled parser avoids pulling in a yaml dependency just
 * for this test. */
function frontmatter(text: string): Record<string, string> {
  expect(text.startsWith("---\n")).toBe(true);
  const end = text.indexOf("\n---\n", 4);
  expect(end).not.toBe(-1);
  const block = text.slice(4, end);
  const out: Record<string, string> = {};
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i === -1) continue;
    const key = line.slice(0, i).trim();
    let value = line.slice(i + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

// --- plugin.json -----------------------------------------------------------

describe("plugin.json", () => {
  const data = JSON.parse(readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"));
  const rootVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

  test("has the expected fields", () => {
    expect(data.name).toBe("self-improvement-loop");
    expect(rootVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(data.version).toBe(rootVersion);
    expect(data.description).toBeTruthy();
    expect(data.author.name).toBe("Mariusz Rakus");
    expect(data.repository).toBe("https://github.com/kolezka/self-improvement-loop");
    expect(data.license).toBe("MIT");
    expect(Array.isArray(data.keywords) && data.keywords.length > 0).toBe(true);
  });
});

// --- build hash covers the plugin contract ----------------------------------
// The hooks module is built against the state contract in types/index.d.ts and
// loaded through the manifest, so dist/.srchash must move when either does.
// Checked on a copy: the tracked files are never edited, since other test
// files read them in parallel.

describe("source hash", () => {
  const CONTRACT = ["types/index.d.ts", ".claude-plugin/plugin.json"];

  test("the real tree hashes the contract and the manifest", () => {
    const files = sourceFiles();
    for (const rel of CONTRACT) expect(files).toContain(rel);
  });

  test.each(CONTRACT)("a change to a copy of %s changes the hash of that copy", (rel) => {
    const original = readFileSync(join(ROOT, rel));
    const copy = mkdtempSync(join(tmpdir(), "sil-srchash-"));
    try {
      for (const f of [...CONTRACT, "package.json", "scripts/build.ts"]) {
        mkdirSync(dirname(join(copy, f)), { recursive: true });
        copyFileSync(join(ROOT, f), join(copy, f));
      }
      // Only the copy is walked, never the real tree.
      expect([...sourceFiles(copy)].sort()).toEqual([".claude-plugin/plugin.json", "package.json", "scripts/build.ts", "types/index.d.ts"]);
      const before = sourceHash(copy);
      // Positive control: hashing is stable when nothing changed.
      expect(sourceHash(copy)).toBe(before);
      writeFileSync(join(copy, rel), Buffer.concat([original, Buffer.from("\n")]));
      expect(sourceHash(copy)).not.toBe(before);
      // The copy's tree is not the real one: the real hash ignores the edit.
      expect(sourceHash(copy)).not.toBe(sourceHash());
    } finally {
      rmSync(copy, { recursive: true, force: true });
    }
    expect(readFileSync(join(ROOT, rel))).toEqual(original);
  });
});

// --- version consistency -----------------------------------------------------
// scripts/bump-version.sh rewrites every copy; this catches a hand edit that
// missed one.

describe("version", () => {
  const rootVersion = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;

  test("every workspace package.json matches the root", () => {
    const manifests = [...globSync("packages/*/package.json", { cwd: ROOT }), ...globSync("apps/*/package.json", { cwd: ROOT })];
    expect(manifests.length).toBeGreaterThan(0);
    for (const rel of manifests) {
      const v = JSON.parse(readFileSync(join(ROOT, rel), "utf8")).version;
      expect([rel, v]).toEqual([rel, rootVersion]);
    }
  });

  test("SIL_VERSION in the health handler matches the root", () => {
    const src = readFileSync(join(ROOT, "packages", "ops", "src", "handlers", "health.ts"), "utf8");
    const m = src.match(/const SIL_VERSION = "([^"]+)";/);
    expect(m?.[1]).toBe(rootVersion);
  });
});

// --- hooks.json --------------------------------------------------------------

// Events the hooks module owns in process; the command hook below skips them
// via the $SIL_HOOK_MODULE guard the module sets. The value is the claude pid
// and the hook's own shell compares it with $PPID, so a nested claude keeps
// its command hooks. Stop/SubagentStop/SessionEnd stay command-only: they run
// the spool handshake and other work the sandbox cannot do.
const MODULE_GUARDED_EVENTS = new Set(["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse"]);
const GUARD_PREFIX = '[ "$SIL_HOOK_MODULE" = "$PPID" ] || ';
// The launcher finds bun outside PATH and says so when there is none.
const LAUNCHER = 'sh "${CLAUDE_PLUGIN_ROOT}/scripts/hook"';

describe("hooks.json", () => {
  const data = JSON.parse(readFileSync(join(ROOT, "hooks", "hooks.json"), "utf8"));
  const hooks = data.hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>>;

  test("covers every event exactly once", () => {
    expect(new Set(Object.keys(hooks))).toEqual(new Set(HOOK_EVENTS));
    for (const event of HOOK_EVENTS) {
      const entries = hooks[event]!;
      expect(entries.length).toBe(1);
      expect(entries[0]!.hooks.length).toBe(1);
    }
  });

  test("registers the hooks module", () => {
    expect(data.modules).toEqual(["../dist/hook-module.js"]);
  });

  test("every event calls the scripts/hook launcher with a timeout of 5s or less", () => {
    for (const entries of Object.values(hooks)) {
      const cmd = entries[0]!.hooks[0]!;
      expect(cmd.type).toBe("command");
      expect(cmd.command.endsWith(LAUNCHER)).toBe(true);
      expect(cmd.timeout).toBeLessThanOrEqual(10);
    }
  });

  test("module-owned events guard the command hook behind $SIL_HOOK_MODULE", () => {
    for (const event of MODULE_GUARDED_EVENTS) {
      const cmd = hooks[event]![0]!.hooks[0]!.command;
      expect(cmd.startsWith(GUARD_PREFIX)).toBe(true);
    }
  });

  test("Stop, SubagentStop, SessionEnd are not guarded", () => {
    for (const event of ["Stop", "SubagentStop", "SessionEnd"]) {
      const cmd = hooks[event]![0]!.hooks[0]!.command;
      expect(cmd.startsWith(GUARD_PREFIX)).toBe(false);
      expect(cmd).toBe(LAUNCHER);
    }
  });

  test("matcher is set only on PreToolUse and PostToolUse", () => {
    for (const [event, entries] of Object.entries(hooks)) {
      const matcher = entries[0]!.matcher;
      if (event === "PreToolUse" || event === "PostToolUse") {
        expect(matcher).toBe("*");
      } else {
        expect(matcher).toBeUndefined();
      }
    }
  });
});

// --- commands/*.md -----------------------------------------------------------

const commandFiles = readdirSync(join(ROOT, "commands"))
  .filter((f) => f.endsWith(".md"))
  .sort();

describe("commands/*.md", () => {
  test("exactly reflect, loop, curriculum, feedback, learn, toolify are present", () => {
    expect(new Set(commandFiles.map((f) => f.replace(/\.md$/, "")))).toEqual(new Set(["reflect", "loop", "curriculum", "feedback", "learn", "toolify"]));
  });

  test.each(commandFiles)("%s has a description in its frontmatter", (name) => {
    const meta = frontmatter(readFileSync(join(ROOT, "commands", name), "utf8"));
    expect(meta.description).toBeTruthy();
  });
});

// --- skill frontmatter -------------------------------------------------------

describe("skills/self-improvement-loop/SKILL.md", () => {
  const skillPath = join(ROOT, "skills", "self-improvement-loop", "SKILL.md");
  const text = readFileSync(skillPath, "utf8");

  test("name and description frontmatter", () => {
    const meta = frontmatter(text);
    expect(meta.name).toBe("self-improvement-loop");
    expect(meta.description?.startsWith("Use when")).toBe(true);
  });

  test("body stays within a 120 line budget", () => {
    expect(text.split("\n").length).toBeLessThanOrEqual(120);
  });
});

// --- no long dashes anywhere in plugin-facing text ---------------------------

const DASH_SCAN_DIRS = ["commands", "skills", "docs", "hooks", ".claude-plugin"];
const DASH_SCAN_FILES = ["README.md"];

function textFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (/\.(md|json)$/.test(name)) files.push(p);
    }
  };
  for (const d of DASH_SCAN_DIRS) {
    const base = join(ROOT, d);
    try {
      if (statSync(base).isDirectory()) walk(base);
    } catch {
      // directory does not exist: nothing to scan
    }
  }
  for (const name of DASH_SCAN_FILES) files.push(join(ROOT, name));
  return files;
}

describe("no em dash or en dash in plugin-facing text", () => {
  test.each(textFiles().map((p) => [p.slice(ROOT.length + 1), p] as const))("%s", (_rel, p) => {
    const text = readFileSync(p, "utf8");
    expect(text.includes(EM)).toBe(false);
    expect(text.includes(EN)).toBe(false);
  });
});

// Built-in nudges fire for every installer, before `sil init` and in every
// world, with no way to turn them off. Personal lessons belong in a world's
// nudges_dir. The dir stays so the hook does not log nudge_dir_missing.
describe("built-in nudges", () => {
  test("the plugin ships none", () => {
    const dir = join(ROOT, "nudges");
    expect(statSync(dir).isDirectory()).toBe(true);
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toEqual([]);
  });
});
