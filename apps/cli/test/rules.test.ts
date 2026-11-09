import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Config, saveConfig, targetRoot, World } from "@sil/core";
import { parseRulesImport, rulesImportBlock } from "@sil/core/rules-import";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-rules-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_CONFIG_DIR"]) saved[k] = process.env[k];
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) process.env[k] = join(tmp, k.toLowerCase());
  delete process.env["CLAUDE_CONFIG_DIR"];
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function world(name: string, claudeDir: string, extra: Partial<World> = {}): World {
  return World.parse({ name, claude_config_dir: claudeDir, ...extra });
}

function writeConfig(worlds: World[]): void {
  saveConfig(Config.parse({ worlds }));
}

function seedRules(w: World): string {
  const path = join(targetRoot(w), w.layout.rules_file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, "<!--loop-rules:start-->\n- a rule <!--rule:a-->\n<!--loop-rules:end-->\n");
  return path;
}

function claudeMdPath(w: World): string {
  return join(w.claude_config_dir as string, "CLAUDE.md");
}

describe("sil rules link", () => {
  test("writes the @import and keeps the user's own CLAUDE.md text", async () => {
    const w = world("default", join(tmp, "claude"));
    const rules = seedRules(w);
    writeConfig([w]);
    const claudeMd = claudeMdPath(w);
    mkdirSync(dirname(claudeMd), { recursive: true });
    writeFileSync(claudeMd, "# Keep me\n\nA line I wrote.\n");

    expect(await run(["rules", "link"])).toBe(0);

    const text = readFileSync(claudeMd, "utf8");
    expect(text.startsWith("# Keep me\n\nA line I wrote.\n")).toBe(true);
    expect(parseRulesImport(text)).toEqual({ path: rules });
  });

  test("a second run changes nothing and says the import is already there", async () => {
    const w = world("default", join(tmp, "claude"));
    seedRules(w);
    writeConfig([w]);
    const claudeMd = claudeMdPath(w);
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => void logs.push(args.join(" "));
    try {
      expect(await run(["rules", "link"])).toBe(0);
      const first = readFileSync(claudeMd, "utf8");
      expect(await run(["rules", "link"])).toBe(0);
      expect(readFileSync(claudeMd, "utf8")).toBe(first);
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("already imports");
  });

  test("--dry-run writes nothing", async () => {
    const w = world("default", join(tmp, "claude"));
    seedRules(w);
    writeConfig([w]);
    const claudeMd = claudeMdPath(w);
    expect(await run(["rules", "link", "--dry-run"])).toBe(0);
    expect(existsSync(claudeMd)).toBe(false);
  });

  test("a stale import is updated in place", async () => {
    const w = world("default", join(tmp, "claude"));
    const rules = seedRules(w);
    writeConfig([w]);
    const claudeMd = claudeMdPath(w);
    mkdirSync(dirname(claudeMd), { recursive: true });
    writeFileSync(claudeMd, `# Keep me\n\n${rulesImportBlock(join(tmp, "old", "RULES.md"))}\n`);

    expect(await run(["rules", "link"])).toBe(0);

    const text = readFileSync(claudeMd, "utf8");
    expect(text.startsWith("# Keep me\n\n")).toBe(true);
    expect(parseRulesImport(text)).toEqual({ path: rules });
  });

  // atomicWrite renames a new inode into place. Without resolving the link
  // first, a dotfiles CLAUDE.md symlink becomes a regular file and the next
  // dotfiles sync silently overwrites the import.
  test("writes through a symlinked CLAUDE.md instead of replacing the link", async () => {
    const w = world("default", join(tmp, "claude"));
    const rules = seedRules(w);
    writeConfig([w]);
    const real = join(tmp, "dotfiles", "CLAUDE.md");
    mkdirSync(dirname(real), { recursive: true });
    writeFileSync(real, "# dotfiles\n");
    const claudeMd = claudeMdPath(w);
    mkdirSync(dirname(claudeMd), { recursive: true });
    symlinkSync(real, claudeMd);

    expect(await run(["rules", "link"])).toBe(0);

    expect(lstatSync(claudeMd).isSymbolicLink()).toBe(true);
    expect(parseRulesImport(readFileSync(real, "utf8"))).toEqual({ path: rules });
  });

  test("refuses two worlds that share one CLAUDE.md but need different rules", async () => {
    const shared = join(tmp, "claude");
    const a = world("a", shared);
    const b = world("b", shared);
    seedRules(a);
    seedRules(b);
    writeConfig([a, b]);

    expect(await run(["rules", "link"])).toBe(1);
    expect(existsSync(join(shared, "CLAUDE.md"))).toBe(false);
  });

  // Disabling injection does not stop Claude Code from loading an import that
  // is already in CLAUDE.md, so the block has to come out.
  test("a world with rules_inject false removes an old import", async () => {
    const w = world("default", join(tmp, "claude"), { rules_inject: false });
    writeConfig([w]);
    const claudeMd = claudeMdPath(w);
    mkdirSync(dirname(claudeMd), { recursive: true });
    writeFileSync(claudeMd, `# Keep me\n\n${rulesImportBlock(join(tmp, "old", "RULES.md"))}\n`);

    expect(await run(["rules", "link", "--world", "default"])).toBe(0);

    const text = readFileSync(claudeMd, "utf8");
    expect(text).toBe("# Keep me\n");
    expect(parseRulesImport(text)).toBeNull();
  });

  test("without --world it removes from an opted-out world and links the rest", async () => {
    const off = world("off", join(tmp, "claude-off"), { rules_inject: false });
    const on = world("on", join(tmp, "claude-on"));
    seedRules(on);
    writeConfig([off, on]);
    const offMd = claudeMdPath(off);
    mkdirSync(dirname(offMd), { recursive: true });
    writeFileSync(offMd, `${rulesImportBlock(join(tmp, "old", "RULES.md"))}\n`);

    expect(await run(["rules", "link"])).toBe(0);

    expect(readFileSync(offMd, "utf8")).toBe("");
    expect(parseRulesImport(readFileSync(claudeMdPath(on), "utf8"))).toEqual({ path: join(targetRoot(on), on.layout.rules_file) });
  });

  // Claude Code stops an @import at whitespace; writing one would make the
  // hook skip injection while the session loads no rules at all.
  test("refuses a rules path that Claude Code cannot expand", async () => {
    const w = World.parse({
      name: "default",
      claude_config_dir: join(tmp, "claude"),
      layout: { rules_file: "sub dir/RULES.md" },
    });
    seedRules(w);
    writeConfig([w]);

    expect(await run(["rules", "link"])).toBe(1);
    expect(existsSync(claudeMdPath(w))).toBe(false);
  });

  test("detects a shared CLAUDE.md reached through a symlinked directory that does not exist yet", async () => {
    const real = join(tmp, "real");
    mkdirSync(real, { recursive: true });
    const link = join(tmp, "link");
    symlinkSync(real, link);
    const a = world("a", join(real, ".claude"));
    const b = world("b", join(link, ".claude"));
    seedRules(a);
    seedRules(b);
    writeConfig([a, b]);

    expect(await run(["rules", "link"])).toBe(1);
    expect(existsSync(join(real, ".claude", "CLAUDE.md"))).toBe(false);
  });

  test("refuses when the rules file does not exist yet", async () => {
    const w = world("default", join(tmp, "claude"));
    writeConfig([w]);
    expect(await run(["rules", "link"])).toBe(1);
    expect(existsSync(claudeMdPath(w))).toBe(false);
  });

  test("--world links only the named world", async () => {
    const a = world("a", join(tmp, "claude-a"));
    const b = world("b", join(tmp, "claude-b"));
    seedRules(a);
    seedRules(b);
    writeConfig([a, b]);

    expect(await run(["rules", "link", "--world", "b"])).toBe(0);

    expect(existsSync(claudeMdPath(a))).toBe(false);
    expect(existsSync(claudeMdPath(b))).toBe(true);
  });
});
