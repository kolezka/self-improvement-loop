import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueEntry } from "@sil/core";
import { listQueue, writeEntry } from "@sil/store";
import { run } from "../src/main.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-queue-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
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

function entry(sessionId: string, world = "default"): QueueEntry {
  return {
    session_id: sessionId,
    transcript_path: join(tmp, `${sessionId}.jsonl`),
    cwd: "/tmp/project",
    world,
    git_head: null,
    first_stop: "2026-11-01T10:00:00.000Z",
    last_stop: "2026-11-01T10:05:00.000Z",
    stops: 1,
    ended: true,
    tool_uses: 5,
    attempts: 2,
    result: "failed: ProviderError: claude -p exited 1: unrecognized_model",
  };
}

function park(sessionId: string, world = "default"): void {
  writeEntry("failed", entry(sessionId, world));
}

describe("sil queue requeue", () => {
  test("moves parked sessions back to pending with a clean slate", async () => {
    park("aaaa-1");
    park("bbbb-2");
    const code = await run(["queue", "requeue", "--failed"]);
    expect(code).toBe(0);
    expect(listQueue("failed")).toHaveLength(0);
    const pending = listQueue("pending");
    expect(pending.map((e) => e.session_id).sort()).toEqual(["aaaa-1", "bbbb-2"]);
    // The old failure reason and the spent attempts would otherwise make the
    // first new attempt look like the third.
    for (const e of pending) {
      expect(e.attempts).toBe(0);
      expect(e.result).toBeNull();
    }
  });

  test("a dry run reports the count and moves nothing", async () => {
    park("aaaa-1");
    const code = await run(["queue", "requeue", "--failed", "--dry-run"]);
    expect(code).toBe(0);
    expect(listQueue("failed")).toHaveLength(1);
    expect(listQueue("pending")).toHaveLength(0);
  });

  test("--world requeues only that world", async () => {
    park("aaaa-1");
    park("bbbb-2", "inkitt");
    const code = await run(["queue", "requeue", "--failed", "--world", "inkitt"]);
    expect(code).toBe(0);
    expect(listQueue("failed").map((e) => e.session_id)).toEqual(["aaaa-1"]);
    expect(listQueue("pending").map((e) => e.session_id)).toEqual(["bbbb-2"]);
  });

  // A crash between the pending write and the unlink leaves one session in
  // both buckets. The worker reads pending, so the failed copy must go: two
  // reflections for one session double its weight behind a pattern and buy a
  // promotion with a single event.
  test("a session already in pending loses its failed copy instead of doubling", async () => {
    park("aaaa-1");
    writeEntry("pending", { ...entry("aaaa-1"), attempts: 0, result: null });
    const code = await run(["queue", "requeue", "--failed"]);
    expect(code).toBe(0);
    expect(listQueue("failed")).toHaveLength(0);
    expect(listQueue("pending").map((e) => e.session_id)).toEqual(["aaaa-1"]);
  });

  test("without --failed it says what it needs and exits 2", async () => {
    park("aaaa-1");
    const code = await run(["queue", "requeue"]);
    expect(code).toBe(2);
    expect(listQueue("failed")).toHaveLength(1);
  });
});
