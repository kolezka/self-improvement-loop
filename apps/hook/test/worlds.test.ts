import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwdUnder, resolveWorld } from "../src/worlds.ts";
import type { HookSnapshot, HookWorld } from "../src/snapshot.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "sil-worlds-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function world(name: string, repos: string[]): HookWorld {
  return { name, repos, nudges_dir: "", rules_file: "", rules_inject: false };
}

describe("cwdUnder", () => {
  test("a repo is under itself", () => {
    mkdirSync(join(root, "repo"), { recursive: true });
    expect(cwdUnder(join(root, "repo"), join(root, "repo"))).toBe(true);
  });

  test("a subdirectory is under the repo", () => {
    mkdirSync(join(root, "repo", "sub"), { recursive: true });
    expect(cwdUnder(join(root, "repo", "sub"), join(root, "repo"))).toBe(true);
  });

  test("a sibling directory is not under the repo", () => {
    mkdirSync(join(root, "repo"), { recursive: true });
    mkdirSync(join(root, "other"), { recursive: true });
    expect(cwdUnder(join(root, "other"), join(root, "repo"))).toBe(false);
  });
});

describe("resolveWorld", () => {
  test("resolves by the longest matching repos prefix", () => {
    const outer = join(root, "outer");
    const inner = join(root, "outer", "inner");
    mkdirSync(inner, { recursive: true });
    const snapshot: HookSnapshot = {
      version: 1,
      worlds: [world("outer-world", [outer]), world("inner-world", [inner])],
      worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: true },
      plugin_root: root,
    };
    expect(resolveWorld(snapshot, inner).name).toBe("inner-world");
    expect(resolveWorld(snapshot, outer).name).toBe("outer-world");
  });

  test("falls back to the catch-all world (empty repos)", () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    const snapshot: HookSnapshot = {
      version: 1,
      worlds: [world("specific", [join(root, "specific-repo")]), world("catch-all", [])],
      worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: true },
      plugin_root: root,
    };
    expect(resolveWorld(snapshot, join(root, "elsewhere")).name).toBe("catch-all");
  });

  test("falls back to the built-in default world when nothing matches at all", () => {
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    const snapshot: HookSnapshot = {
      version: 1,
      worlds: [world("specific", [join(root, "specific-repo")])],
      worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: true },
      plugin_root: root,
    };
    expect(resolveWorld(snapshot, join(root, "elsewhere")).name).toBe("default");
  });
});
