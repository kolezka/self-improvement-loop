// UserPromptSubmit delivers only lessons that arrived since the session
// started. Ported from test_pending_lessons_since_session_start_filters_by_mtime,
// exercised through the real hook entry point end to end.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
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

function writeSnapshot(): void {
  mkdirSync(paths.stateDir(), { recursive: true });
  writeFileSync(
    paths.hookSnapshotFile(),
    JSON.stringify({
      version: 1,
      worlds: [{ name: "default", repos: [], nudges_dir: "", rules_file: "", rules_inject: false }],
      worker: { idle_minutes: 10, curriculum_interval_minutes: 60, min_tool_uses: 6, auto_kick: false },
      plugin_root: hookEnv.pluginRoot,
    }),
  );
}

function writeLesson(id: string, createdIso: string): string {
  const dir = paths.inboxDir("default");
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${id}.json`;
  writeFileSync(path, JSON.stringify({ id, pattern: "test-pattern", text: `lesson body ${id}`, created: createdIso }));
  return path;
}

describe("UserPromptSubmit", () => {
  test("delivers only lessons newer than session start, not ones that predate it", () => {
    writeSnapshot();

    // A SessionStart first, to create start.json.
    const sessionId = "sess-ups-1";
    const startResult = runHook(MAIN_TS, hookEnv, { session_id: sessionId, hook_event_name: "SessionStart", source: "startup", cwd: hookEnv.root });
    expect(startResult.exitCode).toBe(0);

    // A lesson that existed before the session started (backdated mtime).
    const oldPath = writeLesson("old-lesson", "2020-01-01T00:00:00.000Z");
    const old = new Date(Date.now() - 60_000);
    utimesSync(oldPath, old, old);

    // A lesson that arrives after the session started.
    writeLesson("fresh-lesson", "2026-01-01T00:00:00.000Z");

    const result = runHook(MAIN_TS, hookEnv, { session_id: sessionId, hook_event_name: "UserPromptSubmit", prompt: "what should I do next?" });
    expect(result.exitCode).toBe(0);
    const out = result.stdout.trim();
    expect(out).not.toBe("");
    const text = JSON.parse(out).hookSpecificOutput.additionalContext as string;
    expect(text).toContain("lesson body fresh-lesson");
    expect(text).not.toContain("lesson body old-lesson");
  });
});

describe("UserPromptSubmit with no session start on record", () => {
  test("delivers nothing rather than the whole inbox backlog", () => {
    writeSnapshot();
    // No SessionStart ran, so there is no start.json and no session dir: the
    // sinceSessionStart filter used to be skipped entirely here, and every
    // pending lesson landed in the prompt.
    writeLesson("backlog-a", "2020-01-01T00:00:00.000Z");
    writeLesson("backlog-b", "2021-01-01T00:00:00.000Z");

    const result = runHook(MAIN_TS, hookEnv, {
      session_id: "sess-ups-no-start",
      hook_event_name: "UserPromptSubmit",
      prompt: "what should I do next?",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("lesson body backlog-a");
    expect(result.stdout).not.toContain("lesson body backlog-b");
  });
});
