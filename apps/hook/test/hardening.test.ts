// Fast-path hardening: the hook must keep producing its SessionStart text
// when the things around it fail, must never evaluate a nudge lint refused,
// must not take a handler off Object.prototype, and must not carry a test
// hook into the shipped bundle.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as paths from "@sil/core/paths";
import { readJsonl } from "@sil/core/fsx";
import { getHandler } from "../src/handlers.ts";
import { loadSnapshot, DEFAULT_WORKER } from "../src/snapshot.ts";
import { cleanupHookEnv, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

const MAIN_TS = new URL("../src/main.ts", import.meta.url).pathname;

let hookEnv: HookEnv;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  hookEnv = makeHookEnv();
  for (const key of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    ORIGINAL_ENV[key] = process.env[key];
    process.env[key] = hookEnv.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupHookEnv(hookEnv);
});

function writeSnapshotRaw(body: unknown): void {
  mkdirSync(paths.stateDir(), { recursive: true });
  writeFileSync(paths.hookSnapshotFile(), JSON.stringify(body));
}

function goodSnapshot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    worlds: [{ name: "default", repos: [], nudges_dir: "", rules_file: "", rules_inject: false }],
    worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
    plugin_root: hookEnv.pluginRoot,
    ...overrides,
  };
}

describe("getHandler", () => {
  // The event name comes straight off the payload, so `HANDLERS[event]` used
  // to reach Object.prototype and hand main.ts a function to call.
  for (const key of ["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"]) {
    test(`${key} is not a handler`, () => {
      expect(getHandler(key)).toBeUndefined();
    });
  }

  test("a real event still resolves", () => {
    expect(typeof getHandler("SessionStart")).toBe("function");
  });

  test("a payload naming a prototype key exits 0 and prints nothing", () => {
    writeSnapshotRaw(goodSnapshot());
    const result = runHook(MAIN_TS, hookEnv, { session_id: "sess-proto", hook_event_name: "toString" });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
  });
});

describe("a malformed snapshot", () => {
  test("worlds as a number falls back to the default world, output intact", () => {
    // `{"worlds": 5}` reached resolveWorld as a number and threw, which cost
    // the whole SessionStart injection.
    writeSnapshotRaw({ version: 1, worlds: 5, worker: "nope", plugin_root: hookEnv.pluginRoot });
    const result = runHook(MAIN_TS, hookEnv, {
      session_id: "sess-bad-snapshot",
      hook_event_name: "SessionStart",
      source: "startup",
      cwd: hookEnv.root,
    });
    expect(result.exitCode).toBe(0);
    const text = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("self-improvement-loop is active");
  });

  test("loadSnapshot coerces every field independently", () => {
    writeSnapshotRaw({
      version: "one",
      worlds: [5, { repos: [] }, { name: "real", repos: ["/a", 7], nudges_dir: 3 }],
      worker: { idle_minutes: "ten", curriculum_interval_minutes: 30, min_tool_uses: null, auto_kick: "yes" },
      plugin_root: 42,
    });
    const snap = loadSnapshot();
    expect(snap.version).toBe(1);
    expect(snap.worlds.map((w) => w.name)).toEqual(["real"]);
    expect(snap.worlds[0]?.repos).toEqual(["/a"]);
    expect(snap.worlds[0]?.nudges_dir).toBe("");
    expect(snap.worker.idle_minutes).toBe(DEFAULT_WORKER.idle_minutes);
    expect(snap.worker.curriculum_interval_minutes).toBe(30);
    expect(snap.worker.min_tool_uses).toBe(DEFAULT_WORKER.min_tool_uses);
    expect(snap.worker.auto_kick).toBe(DEFAULT_WORKER.auto_kick);
    expect(typeof snap.plugin_root).toBe("string");
    expect(snap.plugin_root).not.toBe("42");
  });

  test("a snapshot with no usable world gets the built-in default", () => {
    writeSnapshotRaw({ version: 1, worlds: [{ repos: [] }], worker: {}, plugin_root: "" });
    expect(loadSnapshot().worlds.map((w) => w.name)).toEqual(["default"]);
  });
});

describe("SessionStart bookkeeping failures", () => {
  test("a read-only session dir still returns the injected text", () => {
    // writeStartJson threw straight out of the handler, so main.ts logged it
    // and dropped text that was already built, and maybeKickWorker never ran.
    writeSnapshotRaw(goodSnapshot());
    const sessionId = "sess-readonly";
    const sdir = paths.sessionDir(sessionId);
    mkdirSync(sdir, { recursive: true });
    chmodSync(sdir, 0o500);
    try {
      const result = runHook(MAIN_TS, hookEnv, {
        session_id: sessionId,
        hook_event_name: "SessionStart",
        source: "startup",
        cwd: hookEnv.root,
      });
      expect(result.exitCode).toBe(0);
      const text = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext as string;
      expect(text).toContain("self-improvement-loop is active");
      expect(existsSync(join(sdir, "start.json"))).toBe(false);
    } finally {
      chmodSync(sdir, 0o700);
    }
  });
});

describe("an unlintable nudge planted in nudges_dir", () => {
  test("never fires, and leaves exactly one breadcrumb per session", () => {
    const nudgesDir = `${hookEnv.root}/nudges`;
    mkdirSync(nudgesDir, { recursive: true });
    writeFileSync(
      `${nudgesDir}/evil.json`,
      JSON.stringify({
        pattern: "evil-nudge",
        event: "PreToolUse",
        matcher: "Bash",
        // Lint refuses this: an alternation inside a quantified group. It
        // matches the payload below, so before the fix it fired.
        gate: { command_matches: "(i|ii)+" },
        once_per: "always",
        text: "evil injected text",
      }),
    );
    writeSnapshotRaw(goodSnapshot({ worlds: [{ name: "default", repos: [], nudges_dir: nudgesDir, rules_file: "", rules_inject: false }] }));

    const payload = { session_id: "sess-evil", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } };
    const first = runHook(MAIN_TS, hookEnv, payload);
    const second = runHook(MAIN_TS, hookEnv, payload);
    expect(first.stdout.trim()).toBe("");
    expect(second.stdout.trim()).toBe("");

    const fires = readJsonl(paths.nudgeFiresFile());
    expect(fires.some((f) => f["pattern"] === "evil-nudge")).toBe(false);
    const invalid = fires.filter((f) => f["kind"] === "nudge_invalid");
    expect(invalid.length).toBe(1);
    expect(invalid[0]?.["file"]).toBe(`${nudgesDir}/evil.json`);
  });
});

/** Wait for a file a detached child writes after the parent has already gone.
 * Polling is the only option: the kick is deliberately fire and forget, so the
 * hook exits without waiting for it and there is nothing to await. */
async function waitForFile(path: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && !existsSync(path)) await Bun.sleep(25);
}

describe("the spawn log test hook", () => {
  test("is not reachable from the environment", async () => {
    // An env-var switch ships in the bundle: anything that can set a variable
    // on the hook could make it write to a path of its choosing, and a kick
    // that should have happened silently did not.
    const fakeBinDir = `${hookEnv.root}/fakebin`;
    const record = `${hookEnv.root}/fake-bun-argv`;
    const envLog = `${hookEnv.root}/env-spawn.log`;
    mkdirSync(fakeBinDir, { recursive: true });
    writeFileSync(`${fakeBinDir}/bun`, `#!/bin/sh\nprintf '%s\\n' "$*" >> ${record}\nexit 0\n`);
    chmodSync(`${fakeBinDir}/bun`, 0o755);

    writeSnapshotRaw(goodSnapshot({ worker: { ...DEFAULT_WORKER, auto_kick: true } }));
    mkdirSync(paths.queueDir("pending"), { recursive: true });
    writeFileSync(`${paths.queueDir("pending")}/some-session.json`, "{}");

    // Launch the hook with the real bun by absolute path, but give the child
    // a PATH whose first `bun` is the recorder: that is the one the kick
    // resolves, so the record file is the positive control for "a kick ran".
    const proc = Bun.spawnSync([process.execPath, MAIN_TS], {
      stdin: Buffer.from(JSON.stringify({ session_id: "sess-kick", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root }), "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...hookEnv.env, PATH: `${fakeBinDir}:${hookEnv.env["PATH"]}`, SIL_TEST_SPAWN_LOG: envLog },
    });

    expect(proc.exitCode).toBe(0);
    // The env branch would have written this from inside the hook process, so
    // it is already decided by the time the hook exits.
    expect(existsSync(envLog)).toBe(false);

    // The record is not: the kick spawns detached and unrefs, so the fake bun
    // runs after the hook has exited. Measured on macOS it lands 290 to 510 ms
    // later, which an immediate existsSync always loses.
    await waitForFile(record);
    // The kick still happened, so the missing envLog is the env branch being
    // gone rather than the kick being skipped.
    expect(existsSync(record)).toBe(true);
    expect(readFileSync(record, "utf8")).toContain("worker --once");
  });
});
