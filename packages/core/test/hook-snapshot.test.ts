import { describe, expect, test } from "bun:test";
import { DEFAULT_WORKER, coerceSnapshot, cwdUnder, defaultWorldFor, resolveWorld } from "../src/hook-snapshot.ts";
import type { HookSnapshot, HookWorld } from "../src/hook-snapshot.ts";

const DEFAULTS = { defaultWorld: defaultWorldFor("/data/worlds/default/learned"), pluginRoot: "/plugin" };

// Stands in for realpathSync: no symlinks, just an absolute normalised path.
const identity = (p: string): string => p;

function world(name: string, repos: string[]): HookWorld {
  return { name, repos, nudges_dir: "", rules_file: "", rules_inject: false };
}

function snapshot(worlds: HookWorld[]): HookSnapshot {
  return { version: 1, worlds, worker: { ...DEFAULT_WORKER }, plugin_root: "/plugin" };
}

describe("defaultWorldFor", () => {
  test("hangs nudges and rules off the given target", () => {
    expect(defaultWorldFor("/d/learned")).toEqual({
      name: "default",
      repos: [],
      nudges_dir: "/d/learned/nudges",
      rules_file: "/d/learned/RULES.md",
      rules_inject: true,
    });
  });
});

describe("coerceSnapshot", () => {
  test("a non-object yields the all-defaults snapshot", () => {
    for (const bad of [undefined, null, 5, "a string", ["a", "list"]]) {
      const snap = coerceSnapshot(bad, DEFAULTS);
      expect(snap.version).toBe(1);
      expect(snap.worlds).toEqual([DEFAULTS.defaultWorld]);
      expect(snap.worker).toEqual(DEFAULT_WORKER);
      expect(snap.plugin_root).toBe("/plugin");
    }
  });

  test("a partial record keeps what is there and defaults the rest", () => {
    const snap = coerceSnapshot({ version: 2, worker: { idle_minutes: 3 } }, DEFAULTS);
    expect(snap.version).toBe(2);
    expect(snap.worlds).toEqual([DEFAULTS.defaultWorld]);
    expect(snap.worker).toEqual({ ...DEFAULT_WORKER, idle_minutes: 3 });
    expect(snap.plugin_root).toBe("/plugin");
  });

  test('"worlds": 5 never reaches resolveWorld as a number', () => {
    // A hand-edited or half-written snapshot used to cost the whole
    // SessionStart injection here.
    const snap = coerceSnapshot({ worlds: 5 }, DEFAULTS);
    expect(Array.isArray(snap.worlds)).toBe(true);
    expect(snap.worlds).toEqual([DEFAULTS.defaultWorld]);
    expect(resolveWorld(snap, "/anywhere", identity).name).toBe("default");
  });

  test("one bad key costs one key", () => {
    const snap = coerceSnapshot(
      {
        version: "not a number",
        worlds: [{ name: "w", repos: ["/r", 7], nudges_dir: 9 }, { repos: [] }, "junk"],
        worker: { idle_minutes: "x", auto_kick: false, min_tool_uses: 1 },
        plugin_root: "",
      },
      DEFAULTS,
    );
    expect(snap.version).toBe(1);
    expect(snap.worlds).toEqual([{ name: "w", repos: ["/r"], nudges_dir: "", rules_file: "", rules_inject: true }]);
    expect(snap.worker).toEqual({ ...DEFAULT_WORKER, auto_kick: false, min_tool_uses: 1 });
    expect(snap.plugin_root).toBe("/plugin");
  });

  test("rules_inject is on unless it is exactly false", () => {
    const snap = coerceSnapshot({ worlds: [{ name: "a", rules_inject: false }, { name: "b", rules_inject: "no" }] }, DEFAULTS);
    expect(snap.worlds.map((w) => w.rules_inject)).toEqual([false, true]);
  });

  test("a non-finite version falls back", () => {
    expect(coerceSnapshot({ version: Number.NaN }, DEFAULTS).version).toBe(1);
  });

  test("an empty string in repos is dropped, not kept", () => {
    // path.resolve("") is the process cwd, so a kept "" would make this
    // world's repos match every cwd in resolveWorld.
    const snap = coerceSnapshot({ worlds: [{ name: "w", repos: ["/r", ""] }] }, DEFAULTS);
    expect(snap.worlds).toEqual([{ name: "w", repos: ["/r"], nudges_dir: "", rules_file: "", rules_inject: true }]);
  });
});

describe("resolveWorld", () => {
  test("longest repos prefix wins", () => {
    const snap = snapshot([world("outer", ["/a"]), world("inner", ["/a/b/c"]), world("middle", ["/a/b"])]);
    expect(resolveWorld(snap, "/a/b/c/d", identity).name).toBe("inner");
    expect(resolveWorld(snap, "/a/b/x", identity).name).toBe("middle");
    expect(resolveWorld(snap, "/a/x", identity).name).toBe("outer");
  });

  test("a shared name prefix does not match", () => {
    const snap = snapshot([world("b-world", ["/a/b"])]);
    expect(resolveWorld(snap, "/a/bc", identity, world("fallback", [])).name).toBe("fallback");
  });

  test("the first world with empty repos is the catch-all", () => {
    const snap = snapshot([world("specific", ["/other"]), world("catch-all", []), world("second-catch-all", [])]);
    expect(resolveWorld(snap, "/elsewhere", identity).name).toBe("catch-all");
  });

  test("a repo match beats the catch-all", () => {
    const snap = snapshot([world("catch-all", []), world("specific", ["/a"])]);
    expect(resolveWorld(snap, "/a/b", identity).name).toBe("specific");
  });

  test("no match and no catch-all falls back to the given world", () => {
    const snap = snapshot([world("specific", ["/other"])]);
    const fallback = world("injected-default", []);
    expect(resolveWorld(snap, "/elsewhere", identity, fallback)).toBe(fallback);
    // Without one, the built-in default world stands in, still named "default".
    expect(resolveWorld(snap, "/elsewhere", identity).name).toBe("default");
  });

  test("realpath is applied to the cwd and to every repo", () => {
    const seen: string[] = [];
    const realpath = (p: string): string => {
      seen.push(p);
      return p === "/link" ? "/a/b" : p;
    };
    const snap = snapshot([world("target", ["/a"])]);
    expect(resolveWorld(snap, "/link", realpath).name).toBe("target");
    expect(seen).toEqual(["/link", "/a"]);
  });

  test("a malformed world entry is skipped, not thrown on", () => {
    const snap = snapshot([null as unknown as HookWorld, { name: "ok" } as HookWorld, world("hit", ["/a"])]);
    expect(resolveWorld(snap, "/a/b", identity).name).toBe("hit");
  });
});

describe("cwdUnder", () => {
  test("the repo itself and anything below it", () => {
    expect(cwdUnder("/a/b", "/a/b", identity)).toBe(true);
    expect(cwdUnder("/a/b/c", "/a/b", identity)).toBe(true);
  });

  test("a sibling with a shared prefix is not under", () => {
    expect(cwdUnder("/a/bc", "/a/b", identity)).toBe(false);
  });

  test("a realpath that throws is not-under, never an exception", () => {
    const boom = (): string => {
      throw new Error("no such path");
    };
    expect(cwdUnder("/a", "/a", boom)).toBe(false);
  });
});
