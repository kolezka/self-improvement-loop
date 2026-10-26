// The command hook writes its four usage logs into loop state when the
// database is ready (design D5), and spills to the old paths when it is not.
// Every case runs the real hook entry as a subprocess.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { readJsonl } from "@sil/core/fsx";
import { serializeSpool, SPOOL_FILE_NAME, SPOOL_VERSION } from "@sil/core/spool";
import type { SpoolAppend } from "@sil/core/spool";
import { closeState, openState, readRecords } from "@sil/statedb";
import { cleanupHookEnv, MAIN_TS, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

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
  closeState();
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
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

function createDb(): void {
  openState();
  closeState();
}

const oldPaths = (): string[] => [paths.usageEventsFile(), paths.hookRunsFile(), paths.nudgeFiresFile(), paths.payloadSamplesFile("default")];

const spillingLines = (): string[] => {
  const file = paths.logFile("hook");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.includes("loop state not opened, spilling"));
};

const SKILL_PAYLOAD = { session_id: "sess-sw-skill", hook_event_name: "PostToolUse", tool_name: "Skill", tool_input: { skill: "some-skill" } };
const BASH_PAYLOAD = { session_id: "sess-sw-bash", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } };

function writeFiftyLineSpool(sessionId: string): void {
  const appends: SpoolAppend[] = [];
  for (let i = 0; i < 20; i++) appends.push({ target: { kind: "usage-events" }, line: JSON.stringify({ ts: "x", kind: "skill", ref: `skill:s${i}` }) });
  for (let i = 0; i < 20; i++) appends.push({ target: { kind: "hook-runs" }, line: JSON.stringify({ ts: "x", kind: "hook_run", ref: `hook:h${i}` }) });
  for (let i = 0; i < 5; i++) appends.push({ target: { kind: "nudge-fires" }, line: JSON.stringify({ ts: "x", session_id: sessionId, event: "PreToolUse", pattern: `p${i}` }) });
  for (let i = 0; i < 5; i++) appends.push({ target: { kind: "payload-samples", world: "default" }, line: JSON.stringify({ ts: "x", tool_name: "Bash", i }) });
  mkdirSync(paths.sessionDir(sessionId), { recursive: true });
  writeFileSync(
    `${paths.sessionDir(sessionId)}/${SPOOL_FILE_NAME}`,
    serializeSpool({ version: SPOOL_VERSION, session_id: sessionId, written_at: "2026-10-26T00:00:00.000Z", appends, moves: [] }),
  );
}

const stopPayload = (sessionId: string) => ({ session_id: sessionId, hook_event_name: "Stop", stop_hook_active: false, cwd: hookEnv.root });

describe("hook writes with loop state ready", () => {
  test("a PostToolUse Skill is one usage_events row and no events.jsonl", () => {
    writeSnapshot();
    createDb();
    expect(runHook(MAIN_TS, hookEnv, SKILL_PAYLOAD).exitCode).toBe(0);
    expect(existsSync(paths.usageEventsFile())).toBe(false);
    const rows = readRecords("usage_events", "strict").records;
    expect(rows.map((r) => r["ref"])).toEqual(["skill:some-skill"]);
  });

  test("a PreToolUse Bash is one payload_samples row of world default and no payloads file", () => {
    writeSnapshot();
    createDb();
    expect(runHook(MAIN_TS, hookEnv, BASH_PAYLOAD).exitCode).toBe(0);
    expect(existsSync(paths.payloadSamplesFile("default"))).toBe(false);
    const rows = readRecords("payload_samples", "strict", "default").records;
    expect(rows.map((r) => r["tool_name"])).toEqual(["Bash"]);
  });

  test("a Stop with a 50-line module spool fills the four streams and leaves no usage files", () => {
    writeSnapshot();
    createDb();
    writeFiftyLineSpool("sess-sw-spool");
    expect(runHook(MAIN_TS, hookEnv, stopPayload("sess-sw-spool")).exitCode).toBe(0);
    for (const file of oldPaths()) expect({ file, exists: existsSync(file) }).toEqual({ file, exists: false });
    expect(readRecords("usage_events", "strict").records.length).toBe(20);
    expect(readRecords("hook_runs", "strict").records.length).toBe(20);
    expect(readRecords("nudge_fires", "strict").records.length).toBe(5);
    expect(readRecords("payload_samples", "strict", "default").records.length).toBe(5);
  });

  test("a fired nudge is one nudge_fires row with its pattern", () => {
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
    createDb();
    const payload = { session_id: "sess-sw-nudge", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(JSON.parse(result.stdout.trim()).hookSpecificOutput.additionalContext).toBe("Write a good commit message.");
    expect(existsSync(paths.nudgeFiresFile())).toBe(false);
    const fires = readRecords("nudge_fires", "strict").records.filter((f) => typeof f["pattern"] === "string");
    expect(fires.map((f) => f["pattern"])).toEqual(["commit-nudge"]);
  });
});

describe("hook writes with no loop state file", () => {
  // No openState here: these read the old paths directly, which an import would move.
  test("the same payloads append to the old paths, and hook.log says why once per process", () => {
    writeSnapshot();
    expect(runHook(MAIN_TS, hookEnv, SKILL_PAYLOAD).exitCode).toBe(0);
    expect(readJsonl(paths.usageEventsFile()).map((e) => e["ref"])).toEqual(["skill:some-skill"]);
    expect(spillingLines().length).toBe(1);

    expect(runHook(MAIN_TS, hookEnv, BASH_PAYLOAD).exitCode).toBe(0);
    expect(readJsonl(paths.payloadSamplesFile("default")).map((e) => e["tool_name"])).toEqual(["Bash"]);

    writeFiftyLineSpool("sess-sw-spill");
    const before = spillingLines().length;
    expect(runHook(MAIN_TS, hookEnv, stopPayload("sess-sw-spill")).exitCode).toBe(0);
    // One Stop process, many writes: one hook.log line.
    expect(spillingLines().length - before).toBe(1);
    expect(readJsonl(paths.usageEventsFile()).length).toBe(21);
    expect(readJsonl(paths.hookRunsFile()).length).toBe(20);
    expect(readJsonl(paths.nudgeFiresFile()).filter((f) => /^p\d$/.test(String(f["pattern"] ?? ""))).length).toBe(5);
    expect(readJsonl(paths.payloadSamplesFile("default")).length).toBe(6);
    expect(existsSync(paths.loopStateDb())).toBe(false);
  });
});
