import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { posix } from "node:path";
import * as paths from "../src/paths.ts";
import { expandHomeWith, isWithin, layout, posixBasename, posixDirname, posixJoin, safeComponent } from "../src/layout.ts";
import type { LayoutEnv } from "../src/layout.ts";

const ENV_KEYS = ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "XDG_DATA_HOME"];
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) {
    ORIGINAL[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = ORIGINAL[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function envWith(vars: Record<string, string>, home = "/home/tester"): LayoutEnv {
  return { get: (name) => vars[name], home };
}

describe("layout precedence", () => {
  test("SIL_STATE_DIR wins over XDG_STATE_HOME and over the home default", () => {
    const l = layout(envWith({ SIL_STATE_DIR: "/explicit/state", XDG_STATE_HOME: "/xdg/state" }));
    expect(l.stateDir()).toBe("/explicit/state");
  });

  test("XDG_STATE_HOME wins over the home default", () => {
    const l = layout(envWith({ XDG_STATE_HOME: "/xdg/state" }));
    expect(l.stateDir()).toBe("/xdg/state/self-improvement-loop");
  });

  test("with neither set, each root falls back under home", () => {
    const l = layout(envWith({}));
    expect(l.configDir()).toBe("/home/tester/.config/self-improvement-loop");
    expect(l.stateDir()).toBe("/home/tester/.local/state/self-improvement-loop");
    expect(l.dataDir()).toBe("/home/tester/.local/share/self-improvement-loop");
  });

  test("an empty env var is treated as unset, not as an empty path", () => {
    const l = layout(envWith({ SIL_DATA_DIR: "" }));
    expect(l.dataDir()).toBe("/home/tester/.local/share/self-improvement-loop");
  });

  test("~ is expanded in both the SIL and the XDG variable", () => {
    expect(layout(envWith({ SIL_STATE_DIR: "~/state" })).stateDir()).toBe("/home/tester/state");
    expect(layout(envWith({ SIL_STATE_DIR: "~" })).stateDir()).toBe("/home/tester");
    expect(layout(envWith({ XDG_DATA_HOME: "~/share" })).dataDir()).toBe("/home/tester/share/self-improvement-loop");
  });

  test("a mid-path ~ is left alone", () => {
    expect(expandHomeWith("/opt/~/x", "/home/tester")).toBe("/opt/~/x");
    expect(expandHomeWith("~user/x", "/home/tester")).toBe("~user/x");
  });

  test("every leaf hangs off the right root", () => {
    const l = layout(envWith({ SIL_STATE_DIR: "/s", SIL_DATA_DIR: "/d" }));
    expect(l.queueDir("pending")).toBe("/s/queue/pending");
    expect(l.usageEventsFile()).toBe("/s/usage/events.jsonl");
    expect(l.hookRunsFile()).toBe("/s/usage/hook-runs.jsonl");
    expect(l.payloadSamplesFile("w")).toBe("/s/usage/payloads/w.jsonl");
    expect(l.nudgeFiresFile()).toBe("/s/usage/nudge-fires.jsonl");
    expect(l.inboxDir("w")).toBe("/s/inbox/w");
    expect(l.sessionDir("sess")).toBe("/s/sessions/sess");
    expect(l.workerLockFile()).toBe("/s/worker.lock");
    expect(l.hookSnapshotFile()).toBe("/s/hook-config.json");
    expect(l.logFile("hook")).toBe("/s/logs/hook.log");
    expect(l.worldDir("w")).toBe("/d/worlds/w");
    expect(l.defaultTarget("w")).toBe("/d/worlds/w/learned");
  });

  test("a traversing world name cannot escape its root", () => {
    const l = layout(envWith({ SIL_STATE_DIR: "/s" }));
    expect(l.inboxDir("../../etc")).toBe("/s/inbox/.._.._etc");
    expect(safeComponent("..")).toBe("_");
  });
});

describe("posixJoin", () => {
  const CASES: string[][] = [
    ["/a", "b"],
    ["/a/", "b"],
    ["/a//", "//b"],
    ["/a", "b/"],
    ["/a/b", ".."],
    ["/a/b", "..", "..", ".."],
    ["a", ".."],
    ["..", ".."],
    ["/a", ".", "b"],
    ["", "b"],
    ["/", "a"],
    ["/", "/"],
    ["/a/b/c", "../../d"],
    ["a/b", "../../../c"],
    [],
    [""],
  ];

  test("matches node:path posix join on every case", () => {
    for (const parts of CASES) {
      expect(`${parts.join(" | ")} -> ${posixJoin(...parts)}`).toBe(`${parts.join(" | ")} -> ${posix.join(...parts)}`);
    }
  });

  test("collapses separators, drops dot segments and resolves dot-dot", () => {
    expect(posixJoin("/a//b", ".", "c")).toBe("/a/b/c");
    expect(posixJoin("/a/b/c", "..", "d")).toBe("/a/b/d");
    expect(posixJoin("/a", "..", "..")).toBe("/");
  });
});

describe("posixDirname and posixBasename", () => {
  const CASES = ["/a/b/c", "/a/b/", "/a", "/", "a", "a/b", "", "a/b/", "//a", "/a//b"];

  test("match node:path posix on every case", () => {
    for (const p of CASES) {
      expect(`${p} -> ${posixDirname(p)}`).toBe(`${p} -> ${posix.dirname(p)}`);
      expect(`${p} -> ${posixBasename(p)}`).toBe(`${p} -> ${posix.basename(p)}`);
    }
  });
});

describe("isWithin", () => {
  test("a path is within itself", () => {
    expect(isWithin("/a/b", "/a/b")).toBe(true);
  });

  test("a child is within its parent", () => {
    expect(isWithin("/a/b/c", "/a/b")).toBe(true);
  });

  test("a shared name prefix is not containment", () => {
    // /a/bc used to read as "under /a/b" under a naive startsWith.
    expect(isWithin("/a/bc", "/a/b")).toBe(false);
    expect(isWithin("/a/b-other", "/a/b")).toBe(false);
  });

  test("a sibling is not within", () => {
    expect(isWithin("/a/other", "/a/b")).toBe(false);
  });

  test("a parent is not within its own child", () => {
    expect(isWithin("/a", "/a/b")).toBe(false);
  });

  test("root contains everything", () => {
    expect(isWithin("/a/b", "/")).toBe(true);
    expect(isWithin("/", "/")).toBe(true);
  });
});

describe("paths.ts and layout() agree", () => {
  const ENV_CASES: Array<Record<string, string>> = [
    { SIL_CONFIG_DIR: "/tmp/sil-eq/config", SIL_STATE_DIR: "/tmp/sil-eq/state", SIL_DATA_DIR: "/tmp/sil-eq/data" },
    { XDG_CONFIG_HOME: "/tmp/sil-eq/xdg-config", XDG_STATE_HOME: "/tmp/sil-eq/xdg-state", XDG_DATA_HOME: "/tmp/sil-eq/xdg-data" },
    { SIL_STATE_DIR: "~/tilde-state", XDG_DATA_HOME: "~/tilde-data" },
    {},
  ];

  test("every function in the Layout interface returns the same string", () => {
    for (const vars of ENV_CASES) {
      for (const key of ENV_KEYS) delete process.env[key];
      for (const [key, value] of Object.entries(vars)) process.env[key] = value;

      const l = layout({ get: (name) => process.env[name], home: homedir() });
      const label = JSON.stringify(vars);
      const fromLayout = {
        configDir: l.configDir(),
        stateDir: l.stateDir(),
        dataDir: l.dataDir(),
        queueDir: l.queueDir("failed"),
        usageEventsFile: l.usageEventsFile(),
        hookRunsFile: l.hookRunsFile(),
        payloadSamplesFile: l.payloadSamplesFile("Koleżka world/../x"),
        nudgeFiresFile: l.nudgeFiresFile(),
        inboxDir: l.inboxDir("Koleżka world/../x"),
        sessionDir: l.sessionDir("sess id/../x"),
        workerLockFile: l.workerLockFile(),
        hookSnapshotFile: l.hookSnapshotFile(),
        logFile: l.logFile("hook"),
        worldDir: l.worldDir("Koleżka world/../x"),
        defaultTarget: l.defaultTarget("Koleżka world/../x"),
      };
      const fromPaths = {
        configDir: paths.configDir(),
        stateDir: paths.stateDir(),
        dataDir: paths.dataDir(),
        queueDir: paths.queueDir("failed"),
        usageEventsFile: paths.usageEventsFile(),
        hookRunsFile: paths.hookRunsFile(),
        payloadSamplesFile: paths.payloadSamplesFile("Koleżka world/../x"),
        nudgeFiresFile: paths.nudgeFiresFile(),
        inboxDir: paths.inboxDir("Koleżka world/../x"),
        sessionDir: paths.sessionDir("sess id/../x"),
        workerLockFile: paths.workerLockFile(),
        hookSnapshotFile: paths.hookSnapshotFile(),
        logFile: paths.logFile("hook"),
        worldDir: paths.worldDir("Koleżka world/../x"),
        defaultTarget: paths.defaultTarget("Koleżka world/../x"),
      };
      expect(`${label} ${JSON.stringify(fromLayout, null, 1)}`).toBe(`${label} ${JSON.stringify(fromPaths, null, 1)}`);
      // Positive control: the roots really did move with the env, so an
      // all-empty comparison cannot be what passed.
      expect(fromPaths.stateDir.length).toBeGreaterThan(1);
    }
  });

  test("paths.ts re-reads the env on every call", () => {
    process.env["SIL_STATE_DIR"] = "/tmp/sil-eq/first";
    expect(paths.workerLockFile()).toBe("/tmp/sil-eq/first/worker.lock");
    process.env["SIL_STATE_DIR"] = "/tmp/sil-eq/second";
    expect(paths.workerLockFile()).toBe("/tmp/sil-eq/second/worker.lock");
  });
});
