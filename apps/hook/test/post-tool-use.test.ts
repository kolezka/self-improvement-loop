// PostToolUse usage events for Skill/Agent tool calls. Ported from
// test_post_tool_use_skill_produces_usage_event and
// test_post_tool_use_agent_produces_usage_event.

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

describe("PostToolUse", () => {
  test("Skill usage produces one usage event with no args in detail", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-ptu-1",
      hook_event_name: "PostToolUse",
      tool_name: "Skill",
      tool_input: { skill: "some-skill", args: "secret free text" },
    };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);

    const events = readJsonl(paths.usageEventsFile());
    expect(events.length).toBe(1);
    expect(events[0]?.["kind"]).toBe("skill");
    expect(events[0]?.["ref"]).toBe("skill:some-skill");
    expect(events[0]?.["detail"]).toEqual({});
    expect(JSON.stringify(events[0])).not.toContain("args");
    expect(JSON.stringify(events[0])).not.toContain("secret free text");
  });

  test("Agent usage produces one usage event with model and description in detail", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-ptu-2",
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: "critic", model: "sonnet", description: "review this change" },
    };
    runHook(MAIN_TS, hookEnv, payload);

    const events = readJsonl(paths.usageEventsFile());
    expect(events.length).toBe(1);
    expect(events[0]?.["kind"]).toBe("agent");
    expect(events[0]?.["ref"]).toBe("agent:critic");
    expect(events[0]?.["detail"]).toEqual({ model: "sonnet", description: "review this change" });
  });

  test("a non-Skill non-Agent tool produces no usage event", () => {
    writeSnapshot();
    const payload = { session_id: "sess-ptu-3", hook_event_name: "PostToolUse", tool_name: "Read", tool_input: { file_path: "x.ts" } };
    runHook(MAIN_TS, hookEnv, payload);
    expect(readJsonl(paths.usageEventsFile()).length).toBe(0);
  });
});
