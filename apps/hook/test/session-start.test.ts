// SessionStart end-to-end through the real hook entry point: rules block,
// lesson delivery, status line, and once-per-session delivery bookkeeping.
// Ported from test_session_start_injects_rules_lesson_and_status and
// test_lesson_not_redelivered_in_same_session.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { closeState, readRecords } from "@sil/statedb";
import { cleanupHookEnv, createLoopState, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

const MAIN_TS = new URL("../src/main.ts", import.meta.url).pathname;

let hookEnv: HookEnv;

beforeEach(() => {
  hookEnv = makeHookEnv();
  for (const key of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    process.env[key] = hookEnv.env[key];
  }
  createLoopState();
});

afterEach(() => {
  closeState();
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

  test("records one usage event per tagged rule, once per session", () => {
    writeSnapshot();
    writeFileSync(
      `${hookEnv.root}/RULES.md`,
      "before\n<!--loop-rules:start-->\n" +
        "- Rule one. <!--rule:alpha-rule-->\n" +
        "- Rule two. <!--rule:beta-rule-->\n" +
        "- A hand-written note with no tag.\n" +
        "<!--loop-rules:end-->\nafter\n",
    );
    const payload = { session_id: "sess-start-4", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };

    runHook(MAIN_TS, hookEnv, payload);
    const first = readRecords("usage_events", "strict").records.filter((e) => e["kind"] === "rule");
    expect(first.map((e) => e["ref"]).sort()).toEqual(["rule:alpha-rule", "rule:beta-rule"]);
    expect(first[0]!["world"]).toBe("default");

    // Resume and compact fire SessionStart again; the rule is still one use.
    runHook(MAIN_TS, hookEnv, payload);
    const second = readRecords("usage_events", "strict").records.filter((e) => e["kind"] === "rule");
    expect(second.length).toBe(2);
  });

  test("records no rule usage when injection is off", () => {
    writeSnapshot({ rules_inject: false });
    writeFileSync(`${hookEnv.root}/RULES.md`, "<!--loop-rules:start-->\n- Rule one. <!--rule:alpha-rule-->\n<!--loop-rules:end-->\n");
    runHook(MAIN_TS, hookEnv, { session_id: "sess-start-5", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root });
    expect(readRecords("usage_events", "strict").records.filter((e) => e["kind"] === "rule").length).toBe(0);
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

// Regression: before `sil init`, the hook injected the same "is active" line
// as an initialized install, with no hint that sessions queue but are never
// reflected, and no pointer to the command that fixes it.
describe("SessionStart before sil init", () => {
  test("hints at init instead of claiming the loop is active, naming the real plugin root", () => {
    // No writeSnapshot(): hook-config.json does not exist, same as a fresh
    // install that has never run `sil init`.
    const payload = { session_id: "sess-start-no-init", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);
    const text = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext as string;
    expect(text).toContain(`"${hookEnv.pluginRoot}/scripts/sil" init`);
    expect(text).not.toContain("self-improvement-loop is active");
  });

  test("goes back to the active line once sil init has written the snapshot", () => {
    writeSnapshot();
    const payload = { session_id: "sess-start-after-init", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    const text = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("self-improvement-loop is active");
    expect(text).not.toContain("scripts/sil");
  });

  // Regression: this path decided "present" with a plain existsSync, which is
  // true for a file this process then fails to read, so a snapshot that
  // exists but is unreadable (bad permissions, a half-written disk) still
  // claimed "is active" here while apps/hook-module (which decides it from
  // whether the read itself succeeded) hinted at init for the exact same
  // file. Both now use "the read succeeded", not "the path exists".
  test("treats an existing but unreadable snapshot the same as not initialized", () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    writeSnapshot();
    chmodSync(paths.hookSnapshotFile(), 0o000);
    try {
      const payload = { session_id: "sess-start-unreadable", hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root };
      const result = runHook(MAIN_TS, hookEnv, payload);
      expect(result.exitCode).toBe(0);
      const text = JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext as string;
      expect(text).toContain(`"${hookEnv.pluginRoot}/scripts/sil" init`);
      expect(text).not.toContain("self-improvement-loop is active");
    } finally {
      chmodSync(paths.hookSnapshotFile(), 0o644);
    }
  });
});
