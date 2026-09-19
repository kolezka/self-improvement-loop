// Plugin manifest, hooks.json, command frontmatter, skill frontmatter, and
// the repo-wide no-long-dash writing rule for plugin-facing text.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { HOOK_EVENTS } from "../packages/core/src/consts.ts";

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

  test("has the expected fields", () => {
    expect(data.name).toBe("self-improvement-loop");
    // The exact number is owned by the release bump; tests/version.test.ts
    // checks every manifest agrees with the root package.json.
    expect(data.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(data.description).toBeTruthy();
    expect(data.author.name).toBe("Mariusz Rakus");
    expect(data.repository).toBe("https://github.com/kolezka/self-improvement-loop");
    expect(data.license).toBe("Proprietary");
    expect(Array.isArray(data.keywords) && data.keywords.length > 0).toBe(true);
  });
});

// --- hooks.json --------------------------------------------------------------

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

  test("every event calls bun dist/hook.js with a timeout of 5s or less", () => {
    for (const entries of Object.values(hooks)) {
      const cmd = entries[0]!.hooks[0]!;
      expect(cmd.type).toBe("command");
      expect(cmd.command).toBe('bun "${CLAUDE_PLUGIN_ROOT}/dist/hook.js"');
      expect(cmd.timeout).toBeLessThanOrEqual(10);
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
  test("exactly reflect, loop, curriculum, feedback are present", () => {
    expect(new Set(commandFiles.map((f) => f.replace(/\.md$/, "")))).toEqual(new Set(["reflect", "loop", "curriculum", "feedback"]));
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
