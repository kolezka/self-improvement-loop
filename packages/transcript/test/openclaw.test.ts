// The OpenClaw transcript format, seen through the Claude Code shaped reader.
// Everything downstream (worker, critic, evidence) stays unchanged, so these
// tests check the adapter output rather than any new worker path.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adaptOpenclawRecords, countToolUses, evidencePack, isOpenclawRecord, iterEvidenceRecords } from "../src/index.ts";

const SESSION_ID = "01JQ0OPENCLAW0000000000001";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "sil-openclaw-transcript-"));
}

/** A small but complete OpenClaw session: header, prompt, tool call, tool
 * result, a skill read and a final answer. */
function records(cwd: string): Record<string, unknown>[] {
  return [
    { type: "session", id: SESSION_ID, cwd, version: "2026.2.26" },
    { type: "message", message: { role: "user", content: "Fix the failing test in foo.py." } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning that must not leak" },
          { type: "text", text: "Running the tests." },
          { type: "toolCall", id: "call_1", name: "exec", arguments: { command: "bun test" } },
        ],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "call_1", toolName: "exec", isError: false, content: "1 pass 0 fail" } },
    {
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "call_2", name: "read", arguments: { path: `${cwd}/skills/debugging/SKILL.md` } }],
      },
    },
    { type: "message", message: { role: "toolResult", toolCallId: "call_2", toolName: "read", isError: false, content: "# debugging" } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Tests pass." }] } },
  ];
}

function writeTranscript(dir: string, recs: Record<string, unknown>[]): string {
  const path = join(dir, "session.jsonl");
  writeFileSync(path, recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return path;
}

describe("isOpenclawRecord", () => {
  test("session header is OpenClaw", () => {
    expect(isOpenclawRecord({ type: "session", id: SESSION_ID, cwd: "/tmp" })).toBe(true);
  });

  test("a Claude Code record is not", () => {
    expect(isOpenclawRecord({ type: "user", sessionId: "abc", message: { role: "user", content: "hi" } })).toBe(false);
  });
});

describe("adaptOpenclawRecords", () => {
  test("maps roles, tool calls and tool results", () => {
    const out = [...adaptOpenclawRecords(records("/repo"))];
    const types = out.map((r) => r["type"]);
    expect(types).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);

    const firstAssistant = out[1] as { message: { content: Array<Record<string, unknown>> } };
    const blocks = firstAssistant.message.content;
    // thinking is dropped: it never reaches an evidence pack in the Claude
    // Code format either.
    expect(blocks.map((b) => b["type"])).toEqual(["text", "tool_use"]);
    expect(blocks[1]!["name"]).toBe("Bash");
    expect(blocks[1]!["id"]).toBe("call_1");

    const toolResult = out[2] as { message: { content: Array<Record<string, unknown>> } };
    expect(toolResult.message.content[0]!["type"]).toBe("tool_result");
    expect(toolResult.message.content[0]!["tool_use_id"]).toBe("call_1");
  });

  test("a read of SKILL.md becomes a Skill tool_use", () => {
    const out = [...adaptOpenclawRecords(records("/repo"))];
    const skillCall = out[3] as { message: { content: Array<Record<string, unknown>> } };
    const block = skillCall.message.content[0]!;
    expect(block["name"]).toBe("Skill");
    expect(block["input"]).toEqual({ skill: "debugging" });
  });

  test("every adapted record carries the session id", () => {
    const out = [...adaptOpenclawRecords(records("/repo"))];
    for (const rec of out) expect(rec["sessionId"]).toBe(SESSION_ID);
  });
});

describe("reading an OpenClaw transcript from disk", () => {
  test("iterEvidenceRecords autodetects the format", () => {
    const dir = tmp();
    const path = writeTranscript(dir, records(dir));
    const out = [...iterEvidenceRecords(path)];
    expect(out[0]!["type"]).toBe("user");
    rmSync(dir, { recursive: true, force: true });
  });

  test("countToolUses sees the tool calls", () => {
    const dir = tmp();
    const path = writeTranscript(dir, records(dir));
    expect(countToolUses(path)).toBe(2); // exec plus the skill read
    rmSync(dir, { recursive: true, force: true });
  });

  test("evidencePack looks like a Claude Code pack", () => {
    const dir = tmp();
    const path = writeTranscript(dir, records(dir));
    const pack = evidencePack(path, dir, { gitHeadAtStart: null });

    expect(pack.session_id).toBe(SESSION_ID);
    expect(pack.prompts).toEqual(["Fix the failing test in foo.py."]);
    expect(pack.counts.tool_uses).toBe(2);
    expect(pack.skills_used).toEqual(["debugging"]);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a Claude Code transcript still reads unchanged", () => {
    const dir = tmp();
    const path = writeTranscript(dir, [
      { type: "user", sessionId: "cc-1", cwd: dir, message: { role: "user", content: "hello" } },
      { type: "assistant", sessionId: "cc-1", message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }] } },
    ]);
    expect(countToolUses(path)).toBe(1);
    expect(evidencePack(path, dir).session_id).toBe("cc-1");
    rmSync(dir, { recursive: true, force: true });
  });
});
