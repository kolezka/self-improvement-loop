// history.series: dense per-day counts, world scoping and skip counts.
// Review Focus 5: a malformed line is counted, not dropped; a record from
// another world is excluded, not counted as skipped; a day with no records is
// a zero, never missing from the array.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { QueueEntry } from "@sil/core";
import { paths } from "@sil/core";
import { appendProposalEvent, writeEntry } from "@sil/store";
import type { HistorySeries } from "../src/handlers/history.ts";
import { invoke } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-ops-history-"));
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

function line(obj: unknown): string {
  return JSON.stringify(obj) + "\n";
}

function appendLine(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line(obj), "utf8");
}

function appendRaw(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text, "utf8");
}

describe("history.series", () => {
  test("dense days, world filter and skipped count", async () => {
    const now = new Date();
    const today = now.toISOString();
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000).toISOString();

    const path = paths.humanFeedbackFile();
    appendLine(path, { ts: today, world: "default", ref: "skill:a", vote: "good", note: "" });
    appendLine(path, { ts: today, world: "default", ref: "skill:a", vote: "good", note: "" });
    appendLine(path, { ts: today, world: "other", ref: "skill:a", vote: "good", note: "" });
    appendLine(path, { ts: twoDaysAgo, world: "default", ref: "skill:a", vote: "bad", note: "" });
    appendRaw(path, "garbage\n");

    const out = (await invoke("history.series", { world: "default", days: 3 })) as HistorySeries;

    expect(out.series.votes_good.map((p) => p.count)).toEqual([0, 0, 2]);
    expect(out.series.votes_bad.map((p) => p.count)).toEqual([1, 0, 0]);
    expect(out.skipped.votes_good + out.skipped.votes_bad).toBeGreaterThanOrEqual(1);
    expect(out.series.reflections).toHaveLength(3);
    // Zero-count days are zeros, not missing.
    expect(out.series.votes_good.map((p) => p.day)).toHaveLength(3);
  });

  test("rejects days out of range", async () => {
    await expect(invoke("history.series", { world: "default", days: 91 })).rejects.toThrow();
  });

  test("a missing feedback file yields zeros; an unreadable one rejects", async () => {
    const zeros = (await invoke("history.series", { world: "default", days: 1 })) as HistorySeries;
    expect(zeros.series.votes_good[0]!.count).toBe(0);
    expect(zeros.skipped.votes_good).toBe(0);

    if (process.getuid?.() === 0) return; // root ignores file permissions
    const path = paths.humanFeedbackFile();
    appendLine(path, { ts: new Date().toISOString(), world: "default", ref: "skill:a", vote: "good", note: "" });
    chmodSync(path, 0o000);
    try {
      await expect(invoke("history.series", { world: "default", days: 1 })).rejects.toThrow();
    } finally {
      chmodSync(path, 0o644);
    }
  });

  test("sessions_done excludes another world and a session queue.clear hid", async () => {
    const entry = (sessionId: string, world: string, lastStop: string): QueueEntry => ({
      session_id: sessionId,
      transcript_path: "/tmp/x.jsonl",
      cwd: "/tmp",
      world,
      git_head: null,
      first_stop: lastStop,
      last_stop: lastStop,
      stops: 1,
      ended: true,
      tool_uses: 5,
      attempts: 0,
      result: "recorded: x",
    });
    const beforeClear = new Date().toISOString();
    writeEntry("done", entry("sess-default", "default", beforeClear));
    writeEntry("done", entry("sess-other-world", "other", beforeClear));
    writeEntry("done", entry("sess-hidden", "default", beforeClear));
    const cleared = (await invoke("queue.clear", { bucket: "done" })) as { done: string };
    // A session that finishes after the clear stays visible.
    writeEntry("done", entry("sess-after-clear", "default", new Date(Date.parse(cleared.done) + 1000).toISOString()));

    const out = (await invoke("history.series", { world: "default", days: 1 })) as HistorySeries;
    expect(out.series.sessions_done[0]!.count).toBe(1);
  });

  test("since compares timestamps by instant, not by string", async () => {
    const path = paths.humanFeedbackFile();
    // By instant, the +02:00 record (2026-09-27T23:00:00Z) is earlier than
    // the Z record (2026-09-27T23:30:00Z), even though its string sorts later.
    appendLine(path, { ts: "2026-09-28T01:00:00+02:00", world: "default", ref: "skill:a", vote: "good", note: "" });
    appendLine(path, { ts: "2026-09-27T23:30:00Z", world: "default", ref: "skill:a", vote: "good", note: "" });

    const out = (await invoke("history.series", { world: "default", days: 90 })) as HistorySeries;
    expect(out.since.votes_good).toBe("2026-09-28T01:00:00+02:00");
  });

  test("proposals draw from the append-only log; worker_runs stays global", async () => {
    appendProposalEvent("default", "verify-callsites", "staged");
    appendProposalEvent("other", "verify-callsites", "staged");
    appendProposalEvent("default", "verify-callsites", "accepted");
    const workerLog = paths.logFile("worker");
    appendLine(workerLog, { ts: new Date().toISOString(), action: "run", reflected: 1, failed: 0, skipped: 0 });
    appendLine(workerLog, { ts: new Date().toISOString(), action: "compact_usage_events", result: "dropped 3" });

    const out = (await invoke("history.series", { world: "default", days: 1 })) as HistorySeries;
    expect(out.series.proposals_staged[0]!.count).toBe(1);
    expect(out.series.proposals_accepted[0]!.count).toBe(1);
    expect(out.since.proposals_staged).not.toBeNull();
    expect(out.series.worker_runs[0]!.count).toBe(1);
  });
});
