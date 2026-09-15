// SubagentStop usage detail is allowlisted to subagent_type only. Ported
// from test_subagent_stop_detail_is_allowlisted_to_subagent_type.

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

describe("SubagentStop", () => {
  test("detail is exactly {subagent_type}, nothing else from the payload leaks", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-sas-1",
      hook_event_name: "SubagentStop",
      subagent_type: "critic",
      prompt: "very sensitive prompt text",
      result: "sensitive result text",
      last_assistant_message: "sensitive message",
      transcript_path: "/tmp/should-not-leak.jsonl",
    };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);
    // SubagentStop is not an OUTPUT_EVENT: no envelope at all.
    expect(result.stdout.trim()).toBe("");

    const events = readJsonl(paths.usageEventsFile());
    expect(events.length).toBe(1);
    expect(events[0]?.["kind"]).toBe("agent_stop");
    expect(events[0]?.["ref"]).toBe("agent:critic");
    expect(events[0]?.["detail"]).toEqual({ subagent_type: "critic" });
    const raw = JSON.stringify(events[0]);
    expect(raw).not.toContain("sensitive");
    expect(raw).not.toContain("should-not-leak");
  });
});
