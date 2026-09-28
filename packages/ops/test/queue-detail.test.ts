// queue.detail: finds an entry across buckets, lists reflections that name
// its session_id, and previews the last 40 transcript messages.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueEntry } from "@sil/core";
import { writeEntry, writeReflection } from "@sil/store";
import { invoke } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-ops-queue-detail-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function entry(sessionId: string, overrides: Partial<QueueEntry> = {}): QueueEntry {
  return {
    session_id: sessionId,
    transcript_path: join(tmp, `${sessionId}.jsonl`),
    cwd: tmp,
    world: "default",
    git_head: null,
    first_stop: "2026-09-14T10:00:00Z",
    last_stop: "2026-09-14T10:05:00Z",
    stops: 1,
    ended: true,
    tool_uses: 5,
    attempts: 0,
    result: "recorded: x",
    ...overrides,
  };
}

/** 50 alternating user/assistant records, each with distinct text. */
function writeFiftyMessageTranscript(path: string, sessionId: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < 50; i++) {
    const role = i % 2 === 0 ? "user" : "assistant";
    records.push({
      type: role,
      sessionId,
      timestamp: `2026-09-14T10:${String(i).padStart(2, "0")}:00.000Z`,
      message: { role, content: [{ type: "text", text: `message ${i}` }] },
    });
  }
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

describe("queue.detail", () => {
  test("returns the last 40 of 50 transcript messages, last one matching", async () => {
    const sessionId = "sess-many-messages";
    const e = entry(sessionId);
    writeFiftyMessageTranscript(e.transcript_path, sessionId);
    writeEntry("done", e);

    const out = (await invoke("queue.detail", { session_id: sessionId })) as {
      bucket: string;
      transcript: { role: string; text: string; ts: string | null }[] | null;
      transcript_reason: string | null;
    };

    expect(out.bucket).toBe("done");
    expect(out.transcript).not.toBeNull();
    expect(out.transcript!).toHaveLength(40);
    expect(out.transcript![39]!.text).toBe("message 49");
    expect(out.transcript![39]!.role).toBe("assistant");
  });

  test("a missing transcript file returns null and the reason, not an error", async () => {
    const sessionId = "sess-no-transcript";
    const e = entry(sessionId, { transcript_path: join(tmp, "does-not-exist.jsonl") });
    writeEntry("failed", e);

    const out = (await invoke("queue.detail", { session_id: sessionId })) as {
      bucket: string;
      transcript: unknown;
      transcript_reason: string | null;
    };

    expect(out.bucket).toBe("failed");
    expect(out.transcript).toBeNull();
    expect(out.transcript_reason).toBe("transcript not persisted");
  });

  test("an unknown session id is a validation error", async () => {
    await expect(invoke("queue.detail", { session_id: "no-such-session" })).rejects.toThrow(/unknown session/);
  });

  test("redacts a secret in a tool_result transcript preview", async () => {
    const sessionId = "sess-with-secret";
    const e = entry(sessionId);
    const fakeKey = "AKIAABCD1234EFGH5678";
    const records: Record<string, unknown>[] = [
      {
        type: "assistant",
        sessionId,
        timestamp: "2026-09-14T10:00:00.000Z",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", id: "t1" }] },
      },
      {
        type: "user",
        sessionId,
        timestamp: "2026-09-14T10:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "t1", content: `export AWS_KEY=${fakeKey}\n` }],
        },
      },
    ];
    mkdirSync(join(e.transcript_path, ".."), { recursive: true });
    writeFileSync(e.transcript_path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    writeEntry("done", e);

    const out = (await invoke("queue.detail", { session_id: sessionId })) as {
      transcript: { role: string; text: string }[] | null;
    };

    const joined = out.transcript!.map((m) => m.text).join("\n");
    expect(joined).not.toContain(fakeKey);
    expect(joined).toContain("[redacted]");
  });

  test("finds reflections that reference the session's session_id", async () => {
    const sessionId = "sess-with-reflection";
    const e = entry(sessionId);
    writeFiftyMessageTranscript(e.transcript_path, sessionId);
    writeEntry("pending", e);

    const body = "Last updated: 2026-09-14\n\nPattern: verify-callsites\n\n## Reusable lesson\nDo the thing.\n";
    writeReflection("default", { id: "2026-09-14-verify-callsites-aaaa", session_id: sessionId }, body);
    writeReflection("default", { id: "2026-09-14-verify-callsites-bbbb", session_id: "some-other-session" }, body);

    const out = (await invoke("queue.detail", { session_id: sessionId })) as { reflection_ids: string[] };
    expect(out.reflection_ids).toEqual(["2026-09-14-verify-callsites-aaaa"]);
  });
});
