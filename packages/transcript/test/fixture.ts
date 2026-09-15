// Synthetic transcript fixture shared by transcript/critic/worker tests.
// Mirrors tests/test_transcript.py so the ported suites exercise the same shapes.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const SESSION_ID = "sess-fixture-1";

export function writeTranscript(path: string, records: Record<string, unknown>[]): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

function user(uid: string, content: unknown, sessionId: string = SESSION_ID): Record<string, unknown> {
  return {
    type: "user",
    uuid: uid,
    isSidechain: false,
    sessionId,
    timestamp: "2026-09-14T10:00:00.000Z",
    message: { role: "user", content },
  };
}

function assistant(uid: string, content: unknown, sessionId: string = SESSION_ID): Record<string, unknown> {
  return {
    type: "assistant",
    uuid: uid,
    isSidechain: false,
    sessionId,
    timestamp: "2026-09-14T10:00:01.000Z",
    message: { role: "assistant", content },
  };
}

function hookAttachment(hookName: string, exitCode: string, durationMs: string, toolUseId: string): Record<string, unknown> {
  return {
    type: "attachment",
    attachment: {
      type: "hook_success",
      hookName,
      toolUseID: toolUseId,
      hookEvent: hookName.split(":")[0],
      content: "",
      stdout: "",
      stderr: "",
      exitCode,
      command: "true",
      durationMs,
    },
  };
}

/** One user prompt, a Bash tool_use whose result is_error, a Skill
 * tool_use, an Agent tool_use, 2 attachment hook records, an ai-title
 * noise line, a system-ish user record, and a final assistant text. */
export function sampleRecords(sessionId: string = SESSION_ID): Record<string, unknown>[] {
  return [
    user("u0", "Fix the bug in foo.py, tests are failing.", sessionId),
    assistant(
      "a0",
      [
        { type: "text", text: "Let me run the tests first." },
        { type: "tool_use", id: "tool-bash-1", name: "Bash", input: { command: "pytest -q", description: "run tests" } },
      ],
      sessionId,
    ),
    user(
      "u1",
      [
        {
          type: "tool_result",
          tool_use_id: "tool-bash-1",
          is_error: true,
          content: [{ type: "text", text: "FAILED tests/test_foo.py::test_bar - AssertionError" }],
        },
      ],
      sessionId,
    ),
    { type: "ai-title", title: "Fix foo.py bug" },
    assistant(
      "a1",
      [{ type: "tool_use", id: "tool-skill-1", name: "Skill", input: { skill: "debugging", args: "foo.py" } }],
      sessionId,
    ),
    user("u2", [{ type: "tool_result", tool_use_id: "tool-skill-1", is_error: false, content: "ok" }], sessionId),
    assistant(
      "a2",
      [
        {
          type: "tool_use",
          id: "tool-agent-1",
          name: "Agent",
          input: { subagent_type: "explorer", model: "sonnet", description: "explore", prompt: "find callers" },
        },
      ],
      sessionId,
    ),
    user("u3", [{ type: "tool_result", tool_use_id: "tool-agent-1", is_error: false, content: "found 2 callers" }], sessionId),
    hookAttachment("PreToolUse:Bash", "0", "56", "tool-bash-1"),
    hookAttachment("PostToolUse:Bash", "1", "120", "tool-bash-1"),
    user("u4", "<system-reminder>ignore this</system-reminder>", sessionId),
    assistant("a3", [{ type: "text", text: "Fixed the assertion and reran the suite; tests pass now." }], sessionId),
  ];
}

export function writeSampleTranscript(tmpDir: string, sessionId: string = SESSION_ID): string {
  return writeTranscript(join(tmpDir, "transcript.jsonl"), sampleRecords(sessionId));
}

/** Point SIL_CONFIG_DIR/STATE_DIR/DATA_DIR at subdirs of tmpDir. Returns the
 * previous values so the caller can restore them (see packages/core/test). */
export function setSilDirs(tmpDir: string): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmpDir, k.toLowerCase());
  }
  return saved;
}

export function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}
