// PreToolUse nudge dispatch: fires once per session, and a blank
// nudges_dir never falls back to cwd (a malicious nudge planted in the
// operator's own repo must never be picked up). Ported from
// test_pre_tool_use_dispatches_world_nudge_once_per_session and
// test_dispatch_nudge_blank_nudges_dir_ignores_cwd_and_fires_breadcrumb.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { readJsonl } from "@sil/core/fsx";
import { cleanupHookEnv, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

const MAIN_TS = new URL("../src/main.ts", import.meta.url).pathname;

let hookEnv: HookEnv;

beforeEach(() => {
  hookEnv = makeHookEnv();
  for (const key of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    process.env[key] = hookEnv.env[key];
  }
});

afterEach(() => {
  cleanupHookEnv(hookEnv);
});

function writeSnapshot(worldOverrides: Record<string, unknown> = {}): void {
  mkdirSync(paths.stateDir(), { recursive: true });
  writeFileSync(
    paths.hookSnapshotFile(),
    JSON.stringify({
      version: 1,
      worlds: [{ name: "default", repos: [], nudges_dir: "", rules_file: "", rules_inject: false, ...worldOverrides }],
      worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
      plugin_root: hookEnv.pluginRoot,
    }),
  );
}

describe("PreToolUse nudge dispatch", () => {
  test("fires a world nudge once per session", () => {
    const nudgesDir = `${hookEnv.root}/nudges`;
    mkdirSync(nudgesDir, { recursive: true });
    writeFileSync(
      `${nudgesDir}/commit.json`,
      JSON.stringify({
        pattern: "commit-nudge",
        event: "PreToolUse",
        matcher: "Bash",
        gate: { command_matches: "git commit" },
        once_per: "session",
        text: "Write a good commit message.",
      }),
    );
    writeSnapshot({ nudges_dir: nudgesDir });

    const payload = { session_id: "sess-dispatch-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };
    const first = runHook(MAIN_TS, hookEnv, payload);
    expect(JSON.parse(first.stdout.trim()).hookSpecificOutput.additionalContext).toBe("Write a good commit message.");

    const second = runHook(MAIN_TS, hookEnv, payload);
    expect(second.stdout.trim()).toBe("");
  });

  test("a blank nudges_dir is ignored, never falls back to cwd, and writes a breadcrumb", () => {
    // A synthetic plugin root with no "nudges" subdir: the builtin nudges
    // dir is genuinely absent too, so the missing-dir breadcrumb has nothing
    // else to fall back on. Matches the Python fixture's plugin_root, which
    // is deliberately bare for this test.
    const barePluginRoot = `${hookEnv.root}/plugin`;
    mkdirSync(barePluginRoot, { recursive: true });
    const bareEnv = makeHookEnv(barePluginRoot);
    bareEnv.env["SIL_STATE_DIR"] = hookEnv.env["SIL_STATE_DIR"]!;
    bareEnv.env["SIL_DATA_DIR"] = hookEnv.env["SIL_DATA_DIR"]!;
    bareEnv.env["SIL_CONFIG_DIR"] = hookEnv.env["SIL_CONFIG_DIR"]!;
    writeSnapshot({ nudges_dir: "" });

    // A malicious nudge planted in the operator's own repo (cwd), not in any
    // configured nudges_dir. `Path("" or "")` used to resolve to `Path(".")`,
    // the session cwd, so any *.json sitting there became a nudge source.
    const operatorRepo = `${hookEnv.root}/operator-repo`;
    mkdirSync(operatorRepo, { recursive: true });
    writeFileSync(
      `${operatorRepo}/evil.json`,
      JSON.stringify({ pattern: "evil-nudge", event: "PreToolUse", matcher: "Bash", gate: { always: true }, once_per: "always", text: "evil injected text" }),
    );

    const payload = { session_id: "sess-dispatch-2", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };
    const proc = Bun.spawnSync(["bun", MAIN_TS], {
      stdin: Buffer.from(JSON.stringify(payload), "utf8"),
      stdout: "pipe",
      stderr: "pipe",
      env: bareEnv.env,
      cwd: operatorRepo,
    });
    expect(proc.exitCode).toBe(0);
    expect((proc.stdout ?? Buffer.alloc(0)).toString("utf8").trim()).toBe("");

    const fires = readJsonl(paths.nudgeFiresFile());
    expect(fires.some((f) => f["kind"] === "nudge_dir_missing")).toBe(true);
    cleanupHookEnv(bareEnv);
  });
});
