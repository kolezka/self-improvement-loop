// worldClaudeConfigDir: where a world's skills and agents are linked. A world
// that names its own Claude config dir must not depend on the env of whichever
// process happens to accept the artifact.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { Config, World, worldClaudeConfigDir } from "../src/index.ts";

let saved: string | undefined;
beforeEach(() => {
  saved = process.env["CLAUDE_CONFIG_DIR"];
});
afterEach(() => {
  if (saved === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
  else process.env["CLAUDE_CONFIG_DIR"] = saved;
});

describe("worldClaudeConfigDir", () => {
  test("a world's own dir wins over CLAUDE_CONFIG_DIR", () => {
    process.env["CLAUDE_CONFIG_DIR"] = "/tmp/some-other-world/.claude";
    const world = World.parse({ name: "default", claude_config_dir: "/opt/claude-a" });
    expect(worldClaudeConfigDir(world)).toBe("/opt/claude-a");
  });

  test("~ is expanded", () => {
    const world = World.parse({ name: "default", claude_config_dir: "~/.claude" });
    expect(worldClaudeConfigDir(world)).toBe(join(homedir(), ".claude"));
  });

  test("null keeps the env behaviour", () => {
    process.env["CLAUDE_CONFIG_DIR"] = "/tmp/env-claude";
    const world = World.parse({ name: "default" });
    expect(world.claude_config_dir).toBeNull();
    expect(worldClaudeConfigDir(world)).toBe("/tmp/env-claude");
    delete process.env["CLAUDE_CONFIG_DIR"];
    expect(worldClaudeConfigDir(world)).toBe(join(homedir(), ".claude"));
  });

  test.each(["", "relative/.claude", "./x"])("a path that would resolve against cwd is refused (%p)", (bad) => {
    expect(World.safeParse({ name: "default", claude_config_dir: bad }).success).toBe(false);
  });

  test("an existing config without the field still loads", () => {
    const cfg = Config.parse({ worlds: [{ name: "default" }, { name: "inkitt", repos: ["/x"] }] });
    expect(cfg.worlds.map((w) => w.claude_config_dir)).toEqual([null, null]);
  });
});
