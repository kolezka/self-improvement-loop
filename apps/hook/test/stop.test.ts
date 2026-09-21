// Stop: queue upsert, stop_hook_active short-circuit, transcript scan
// (hook_run events + tool_uses), the oversized-line skip/resume, and
// concurrent Stop calls for the same session serializing correctly. Ported
// from test_stop_upserts_queue_entry_and_increments_stops,
// test_stop_with_stop_hook_active_does_nothing,
// test_stop_transcript_scan_produces_hook_run_events_and_tool_uses,
// test_stop_transcript_scan_skips_oversized_line_and_resumes,
// test_concurrent_stop_processes_serialize_queue_and_scan_updates.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { readJsonl } from "@sil/core/fsx";
import { cleanupHookEnv, makeHookEnv, runHook } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

const MAIN_TS = new URL("../src/main.ts", import.meta.url).pathname;
const MAX_TRANSCRIPT_SCAN_BYTES = 20 * 1024 * 1024;

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

function queueEntry(sessionId: string): Record<string, unknown> {
  return JSON.parse(readFileSync(`${paths.queueDir("pending")}/${sessionId}.json`, "utf8"));
}

describe("Stop", () => {
  test("upserts the queue entry and increments stops across calls", () => {
    writeSnapshot();
    const payload = { session_id: "sess-stop-1", hook_event_name: "Stop", stop_hook_active: false, cwd: hookEnv.root };
    runHook(MAIN_TS, hookEnv, payload);
    let entry = queueEntry("sess-stop-1");
    expect(entry["stops"]).toBe(1);
    expect(entry["session_id"]).toBe("sess-stop-1");

    runHook(MAIN_TS, hookEnv, payload);
    entry = queueEntry("sess-stop-1");
    expect(entry["stops"]).toBe(2);
  });

  test("stop_hook_active short-circuits: no queue entry at all", () => {
    writeSnapshot();
    const payload = { session_id: "sess-stop-2", hook_event_name: "Stop", stop_hook_active: true, cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
    expect(() => queueEntry("sess-stop-2")).toThrow();
  });

  // `claude --print --no-session-persistence` (jean and other tools use it for
  // helper runs: commit messages, summaries) reports a transcript_path Claude
  // Code never writes. Queuing those sessions buries the operator's failed
  // list under entries no reflection can ever read.
  test("does not queue a session whose transcript_path is not on disk", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-stop-ephemeral",
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: `${hookEnv.root}/never-written.jsonl`,
      cwd: hookEnv.root,
    };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);
    expect(() => queueEntry("sess-stop-ephemeral")).toThrow();
  });

  test("keeps updating an entry whose transcript disappears after the first Stop", () => {
    writeSnapshot();
    const transcript = `${hookEnv.root}/vanishing-transcript.jsonl`;
    writeFileSync(transcript, `${JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "hi" }] } })}\n`);
    const payload = { session_id: "sess-stop-vanish", hook_event_name: "Stop", stop_hook_active: false, transcript_path: transcript, cwd: hookEnv.root };

    runHook(MAIN_TS, hookEnv, payload);
    expect(queueEntry("sess-stop-vanish")["stops"]).toBe(1);

    rmSync(transcript);
    runHook(MAIN_TS, hookEnv, payload);
    expect(queueEntry("sess-stop-vanish")["stops"]).toBe(2);
  });

  test("Stop is not an OUTPUT_EVENT: no envelope printed even though nudges could match", () => {
    writeSnapshot();
    const payload = { session_id: "sess-stop-3", hook_event_name: "Stop", stop_hook_active: false, cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.stdout.trim()).toBe("");
  });

  test("transcript scan produces hook_run events and counts tool_uses, without duplicating on a repeat call", () => {
    writeSnapshot();
    const transcript = `${hookEnv.root}/transcript.jsonl`;
    const lines = [
      { type: "attachment", attachment: { type: "hook_success", hookName: "hook-a", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } },
      { type: "attachment", attachment: { type: "hook_success", hookName: "hook-b", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } },
      { type: "attachment", attachment: { type: "hook_success", hookName: "hook-c", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }, { type: "text", text: "hi" }] } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit" }] } },
    ];
    writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const payload = { session_id: "sess-stop-4", hook_event_name: "Stop", stop_hook_active: false, transcript_path: transcript, cwd: hookEnv.root };
    runHook(MAIN_TS, hookEnv, payload);

    let events = readJsonl(paths.hookRunsFile());
    const hookRunEvents = events.filter((e) => e["kind"] === "hook_run");
    expect(hookRunEvents.length).toBe(3);
    // hook_run is diagnostics: it must stay out of the scorecard event log,
    // which every scorecard rebuild parses end to end.
    expect(readJsonl(paths.usageEventsFile()).some((e) => e["kind"] === "hook_run")).toBe(false);
    let entry = queueEntry("sess-stop-4");
    expect(entry["tool_uses"]).toBe(2);

    // A second identical Stop must not re-scan the same bytes.
    runHook(MAIN_TS, hookEnv, payload);
    events = readJsonl(paths.hookRunsFile());
    expect(events.filter((e) => e["kind"] === "hook_run").length).toBe(3);
    entry = queueEntry("sess-stop-4");
    expect(entry["stops"]).toBe(2);
    expect(entry["tool_uses"]).toBe(2);
  });

  test("skips a transcript line over MAX_TRANSCRIPT_SCAN_BYTES and resumes on the next Stop", () => {
    writeSnapshot();
    const transcript = `${hookEnv.root}/huge-transcript.jsonl`;
    const hugeLine = "x".repeat(MAX_TRANSCRIPT_SCAN_BYTES + 1024 * 1024);
    const normal = JSON.stringify({ type: "attachment", attachment: { type: "hook_success", hookName: "hook-after", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } });
    writeFileSync(transcript, `${hugeLine}\n${normal}\n`);

    const payload = { session_id: "sess-stop-5", hook_event_name: "Stop", stop_hook_active: false, transcript_path: transcript, cwd: hookEnv.root };

    runHook(MAIN_TS, hookEnv, payload);
    let events = readJsonl(paths.hookRunsFile());
    expect(events.some((e) => e["kind"] === "hook_run")).toBe(false);

    runHook(MAIN_TS, hookEnv, payload);
    events = readJsonl(paths.hookRunsFile());
    const hookRunEvents = events.filter((e) => e["kind"] === "hook_run");
    expect(hookRunEvents.length).toBe(1);
    expect(hookRunEvents[0]?.["ref"]).toBe("hook:hook-after");
  }, 30000);

  test("four concurrent Stop processes for the same session serialize: stops == 4, exactly 3 hook_run events", async () => {
    writeSnapshot();
    const transcript = `${hookEnv.root}/concurrent-transcript.jsonl`;
    const lines = [
      { type: "attachment", attachment: { type: "hook_success", hookName: "hook-a", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } },
      { type: "attachment", attachment: { type: "hook_success", hookName: "hook-b", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } },
      { type: "attachment", attachment: { type: "hook_success", hookName: "hook-c", exitCode: 0, durationMs: 1, hookEvent: "PreToolUse" } },
      { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash" }] } },
    ];
    writeFileSync(transcript, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

    const payload = JSON.stringify({ session_id: "sess-stop-concurrent", hook_event_name: "Stop", stop_hook_active: false, transcript_path: transcript, cwd: hookEnv.root });

    const procs = Array.from({ length: 4 }, () =>
      Bun.spawn(["bun", MAIN_TS], { stdin: Buffer.from(payload, "utf8"), stdout: "pipe", stderr: "pipe", env: hookEnv.env }),
    );
    await Promise.all(procs.map((p) => p.exited));

    const entry = queueEntry("sess-stop-concurrent");
    expect(entry["stops"]).toBe(4);
    expect(entry["tool_uses"]).toBe(1);

    const events = readJsonl(paths.hookRunsFile());
    expect(events.filter((e) => e["kind"] === "hook_run").length).toBe(3);
  }, 30000);
});

describe("SessionEnd", () => {
  test("marks the queue entry ended, creating a zero-stop placeholder if Stop never ran", () => {
    writeSnapshot();
    const payload = { session_id: "sess-end-1", hook_event_name: "SessionEnd", cwd: hookEnv.root };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("");
    const entry = queueEntry("sess-end-1");
    expect(entry["ended"]).toBe(true);
    expect(entry["stops"]).toBe(0);
  });

  test("does not create a placeholder for a session whose transcript_path is not on disk", () => {
    writeSnapshot();
    const payload = {
      session_id: "sess-end-ephemeral",
      hook_event_name: "SessionEnd",
      transcript_path: `${hookEnv.root}/never-written.jsonl`,
      cwd: hookEnv.root,
    };
    const result = runHook(MAIN_TS, hookEnv, payload);
    expect(result.exitCode).toBe(0);
    expect(() => queueEntry("sess-end-ephemeral")).toThrow();
  });

  // SessionEnd read-modify-writes the same queue entry Stop does. Outside the
  // lock, a SessionEnd that read the entry before a concurrent Stop wrote it
  // puts the old stops count back on disk.
  test("waits for the session lock instead of writing over a running Stop", async () => {
    writeSnapshot();
    const sessionId = "sess-end-locked";
    runHook(MAIN_TS, hookEnv, { session_id: sessionId, hook_event_name: "Stop", stop_hook_active: false, cwd: hookEnv.root });
    expect(queueEntry(sessionId)["stops"]).toBe(1);

    // Stands in for a Stop handler holding the lock. The pid is this test
    // process, which is alive, so the lock is never reclaimed as stale.
    const lockDir = `${paths.sessionDir(sessionId)}/lock.lockdir`;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(`${lockDir}/pid`, `${process.pid}\n`, "utf8");

    const payload = JSON.stringify({ session_id: sessionId, hook_event_name: "SessionEnd", cwd: hookEnv.root });
    const proc = Bun.spawn(["bun", MAIN_TS], { stdin: Buffer.from(payload, "utf8"), stdout: "pipe", stderr: "pipe", env: hookEnv.env });

    await Bun.sleep(800);
    expect(queueEntry(sessionId)["ended"]).not.toBe(true);

    rmSync(lockDir, { recursive: true, force: true });
    await proc.exited;
    const entry = queueEntry(sessionId);
    expect(entry["ended"]).toBe(true);
    expect(entry["stops"]).toBe(1);
  }, 30000);

  test("marks an existing queue entry ended without clobbering its stops count", () => {
    writeSnapshot();
    const stopPayload = { session_id: "sess-end-2", hook_event_name: "Stop", stop_hook_active: false, cwd: hookEnv.root };
    runHook(MAIN_TS, hookEnv, stopPayload);
    runHook(MAIN_TS, hookEnv, { session_id: "sess-end-2", hook_event_name: "SessionEnd", cwd: hookEnv.root });
    const entry = queueEntry("sess-end-2");
    expect(entry["ended"]).toBe(true);
    expect(entry["stops"]).toBe(1);
  });
});
