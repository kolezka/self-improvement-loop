// PreToolUse payload sampling. The router tests a drafted gate by running it,
// so the corpus has to contain real commands: a gate on `--no-verify` can
// never match a synthetic fixture. What is recorded is allowlisted, because
// the rest of tool_input is free text the model wrote.

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

const samples = (): Record<string, unknown>[] => readJsonl(paths.payloadSamplesFile("default"));

describe("PreToolUse payload samples", () => {
  test("a Bash call is recorded with its command and nothing else from tool_input", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-pre-1",
      hook_event_name: "PreToolUse",
      tool_name: "Bash",
      tool_input: { command: "git push --no-verify", description: "secret free text" },
    };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);

    const rows = samples();
    expect(rows.length).toBe(1);
    expect(rows[0]?.["tool_name"]).toBe("Bash");
    expect(rows[0]?.["tool_input"]).toEqual({ command: "git push --no-verify" });
    // description is model-written free text, the same privacy call the
    // PostToolUse usage events already make for Skill's "args".
    const line = JSON.stringify(rows[0]);
    expect(line).not.toContain("description");
    expect(line).not.toContain("secret free text");
  });

  test("an Edit call keeps file_path and drops the edited text", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-pre-2",
      hook_event_name: "PreToolUse",
      tool_name: "Edit",
      tool_input: {
        file_path: "/repo/packages/core/src/paths.ts",
        old_string: "AWS_SECRET_ACCESS_KEY=old",
        new_string: "AWS_SECRET_ACCESS_KEY=new",
      },
    };
    runHook(MAIN_TS, hookEnv, payload);

    const rows = samples();
    expect(rows.length).toBe(1);
    expect(rows[0]?.["tool_input"]).toEqual({ file_path: "/repo/packages/core/src/paths.ts" });
    const line = JSON.stringify(rows[0]);
    expect(line).not.toContain("old_string");
    expect(line).not.toContain("new_string");
    expect(line).not.toContain("AWS_SECRET_ACCESS_KEY");
  });

  test("a payload with no tool_name records nothing", () => {
    writeSnapshot();
    runHook(MAIN_TS, hookEnv, { session_id: "sess-pre-3", hook_event_name: "PreToolUse", tool_input: { command: "ls" } });
    expect(samples().length).toBe(0);
  });

  test("credential values in a command are blanked before the write", () => {
    // A gate matches flags and subcommands; the value after a bearer header or
    // a token= assignment is never what a gate reads, and it is what leaks.
    writeSnapshot();
    const command =
      'curl -H "Authorization: Bearer sk-live-abc123" https://api.example.com && export GH_TOKEN=ghp_zzz9 && git push --no-verify';
    runHook(MAIN_TS, hookEnv, { session_id: "sess-pre-4", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command } });

    const stored = String((samples()[0]?.["tool_input"] as Record<string, unknown>)["command"]);
    expect(stored).not.toContain("sk-live-abc123");
    expect(stored).not.toContain("ghp_zzz9");
    expect(stored).toContain("Authorization: Bearer <redacted>");
    expect(stored).toContain("GH_TOKEN=<redacted>");
    expect(stored).toContain("git push --no-verify");
  });

  test("keys no gate predicate reads are not sampled", () => {
    // Grep's pattern, ToolSearch's query and WebFetch's url cannot change a
    // gate result, so they are pure leak surface and stay out of the file.
    writeSnapshot();
    runHook(MAIN_TS, hookEnv, {
      session_id: "sess-pre-5",
      hook_event_name: "PreToolUse",
      tool_name: "Grep",
      tool_input: { pattern: "AKIA[0-9A-Z]{16}", path: "/repo" },
    });
    runHook(MAIN_TS, hookEnv, {
      session_id: "sess-pre-5",
      hook_event_name: "PreToolUse",
      tool_name: "WebFetch",
      tool_input: { url: "https://example.com/?token=abc" },
    });

    const rows = samples();
    expect(rows.map((r) => r["tool_name"])).toEqual(["Grep", "WebFetch"]);
    for (const row of rows) expect(row["tool_input"]).toEqual({});
    const text = JSON.stringify(rows);
    expect(text).not.toContain("AKIA");
    expect(text).not.toContain("token=abc");
  });
});
