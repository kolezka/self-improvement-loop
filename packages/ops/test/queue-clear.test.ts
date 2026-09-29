// queue.clear / queue.unclear: Review Focus 4. "Clear done" hides everything
// up to now; a session that finishes after stays visible; "Show hidden"
// (queue.unclear) restores everything without moving or deleting a file.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueueEntry } from "@sil/core";
import { loadEntry, writeEntry } from "@sil/store";
import { invoke } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-ops-queue-clear-"));
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

function doneEntry(sessionId: string, lastStop: string): QueueEntry {
  return {
    session_id: sessionId,
    transcript_path: "/tmp/x.jsonl",
    cwd: "/tmp",
    world: "default",
    git_head: null,
    first_stop: lastStop,
    last_stop: lastStop,
    stops: 1,
    ended: true,
    tool_uses: 5,
    attempts: 0,
    result: "recorded: x",
  };
}

describe("queue.clear and queue.unclear", () => {
  test("hides entries up to the cutoff; a later one stays visible; unclear restores all", async () => {
    const now = Date.now();
    writeEntry("done", doneEntry("sess-old-1", new Date(now - 2 * 3600_000).toISOString()));
    writeEntry("done", doneEntry("sess-old-2", new Date(now - 3600_000).toISOString()));

    const cleared = (await invoke("queue.clear", { bucket: "done" })) as { done: string | null; failed: string | null };
    expect(cleared.done).not.toBeNull();

    writeEntry("done", doneEntry("sess-new", new Date(Date.parse(cleared.done!) + 1000).toISOString()));

    const list = (await invoke("queue.list", {})) as {
      done: { session_id: string }[];
      failed: { session_id: string }[];
      hidden: { done: number; failed: number };
      cleared: { done: string | null; failed: string | null };
    };
    expect(list.done.map((e) => e.session_id)).toEqual(["sess-new"]);
    expect(list.hidden.done).toBe(2);
    expect(list.hidden.failed).toBe(0);
    expect(list.cleared.done).toBe(cleared.done);

    // No queue file was moved or deleted by the clear.
    expect(loadEntry("done", "sess-old-1")).not.toBeNull();
    expect(loadEntry("done", "sess-old-2")).not.toBeNull();

    const unclear = (await invoke("queue.unclear", { bucket: "done" })) as { done: string | null };
    expect(unclear.done).toBeNull();

    const listAfter = (await invoke("queue.list", {})) as { done: { session_id: string }[]; hidden: { done: number } };
    expect(listAfter.done.map((e) => e.session_id).sort()).toEqual(["sess-new", "sess-old-1", "sess-old-2"].sort());
    expect(listAfter.hidden.done).toBe(0);
  });

  test("clearing one bucket never hides the other", async () => {
    writeEntry("failed", doneEntry("sess-failed-1", new Date().toISOString()));
    await invoke("queue.clear", { bucket: "done" });

    const list = (await invoke("queue.list", {})) as { failed: { session_id: string }[]; hidden: { failed: number } };
    expect(list.failed.map((e) => e.session_id)).toEqual(["sess-failed-1"]);
    expect(list.hidden.failed).toBe(0);
  });
});
