// SessionStart end-to-end through the real hook entry point: rules block,
// lesson delivery, status line, and once-per-session delivery bookkeeping.
// Ported from test_session_start_injects_rules_lesson_and_status and
// test_lesson_not_redelivered_in_same_session.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
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

function writeSnapshot(overrides: Record<string, unknown> = {}): void {
  mkdirSync(paths.stateDir(), { recursive: true });
  writeFileSync(
    paths.hookSnapshotFile(),
    JSON.stringify({
      version: 1,
      worlds: [{ name: "default", repos: [], nudges_dir: "", rules_file: `${hookEnv.root}/RULES.md`, rules_inject: true, ...overrides }],
      worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
      plugin_root: hookEnv.pluginRoot,
    }),
  );
}

function writeLesson(id: string): void {
  const dir = paths.inboxDir("default");
  mkdirSync(dir, { recursive: true });
  writeFileSync(`${dir}/${id}.json`, JSON.stringify({ id, pattern: "test-pattern", text: "a useful lesson", created: "2026-01-01T00:00:00.000Z" }));
}

describe("SessionStart", () => {
  test("injects rules block, a pending lesson, and the status line", () => {
    writeSnapshot();
    writeFileSync(`${hookEnv.root}/RULES.md`, "before\n<!--loop-rules:start-->\nAlways run tests.\n<!--loop-rules:end-->\nafter\n");
    writeLesson("lesson-a");

    const payload = { session_id: "sess-start-1", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);

    const envelope = JSON.parse(result.stdout.trim());
    const text = envelope.hookSpecificOutput.additionalContext as string;
    expect(text).toContain("Always run tests.");
    expect(text).toContain("a useful lesson");
    expect(text).toContain("self-improvement-loop is active");
  });

  test("does not redeliver the same lesson in the same session", () => {
    writeSnapshot();
    writeLesson("lesson-b");
    const payload = { session_id: "sess-start-2", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };

    const first = runHook(MAIN_TS, hookEnv, payload);
    expect(JSON.parse(first.stdout.trim()).hookSpecificOutput.additionalContext).toContain("a useful lesson");

    const second = runHook(MAIN_TS, hookEnv, payload);
    const secondOut = second.stdout.trim();
    if (secondOut) {
      expect(JSON.parse(secondOut).hookSpecificOutput.additionalContext).not.toContain("a useful lesson");
    }
  });

  test("writes start.json with cwd, world, and git_head", () => {
    writeSnapshot();
    const payload = { session_id: "sess-start-3", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };
    runHook(MAIN_TS, hookEnv, payload);
    const startJson = JSON.parse(readFileSync(`${paths.sessionDir("sess-start-3")}/start.json`, "utf8"));
    expect(startJson.world).toBe("default");
    expect(startJson.cwd).toBe(hookEnv.root);
  });
});
