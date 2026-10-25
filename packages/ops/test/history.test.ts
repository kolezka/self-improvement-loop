// history.series: dense per-day counts, world scoping and skip counts.
// Review Focus 5: a malformed line is counted, not dropped; a record from
// another world is excluded, not counted as skipped; a day with no records is
// a zero, never missing from the array.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { QueueEntry } from "@sil/core";
import { paths, StateReadError } from "@sil/core";
import { closeState } from "@sil/statedb";
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
  closeState();
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
    // The garbage line is quarantined at import; both vote series carry it.
    expect(out.skipped.votes_good).toBe(1);
    expect(out.skipped.votes_bad).toBe(1);
    expect(out.series.reflections).toHaveLength(3);
    // Zero-count days are zeros, not missing.
    expect(out.series.votes_good.map((p) => p.day)).toHaveLength(3);
  });

  test("rejects days out of range", async () => {
    await expect(invoke("history.series", { world: "default", days: 91 })).rejects.toThrow();
  });

  test("a missing feedback log yields zeros; an unreadable database rejects with StateReadError", async () => {
    const zeros = (await invoke("history.series", { world: "default", days: 1 })) as HistorySeries;
    expect(zeros.series.votes_good[0]!.count).toBe(0);
    expect(zeros.skipped.votes_good).toBe(0);

    // A directory where the database file goes: a real open failure, not zeros.
    closeState();
    rmSync(paths.loopStateDb(), { force: true });
    mkdirSync(paths.loopStateDb(), { recursive: true });
    let error: unknown = null;
    try {
      await invoke("history.series", { world: "default", days: 1 });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message.startsWith("the human feedback log cannot be read (")).toBe(true);
  });

  test("critic skipped is the stream's quarantine count across worlds; another world's record is excluded", async () => {
    const path = paths.criticFeedbackFile();
    const ts = new Date().toISOString();
    appendLine(path, { ref: "skill:a", verdict: "used", reflection_id: "r1", ts, world: "default" });
    appendLine(path, { ref: "skill:a", verdict: "used", reflection_id: "r2", ts, world: "other" });
    appendRaw(path, "{torn\n");

    const out = (await invoke("history.series", { world: "default", days: 1 })) as HistorySeries;
    expect(out.series.critic_verdicts[0]!.count).toBe(1);
    expect(out.skipped.critic_verdicts).toBe(1);
    expect(out.skipped.votes_good).toBe(0);
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

  test("a re-route is counted in its own series, and still in proposals_staged", async () => {
    // run.ts records "staged" and "rerouted" for the same commit when a
    // re-route lands, so "rerouted" is a distinct series without pulling
    // those commits out of "staged".
    appendProposalEvent("default", "verify-callsites", "staged");
    appendProposalEvent("default", "verify-callsites", "rerouted");

    const out = (await invoke("history.series", { world: "default", days: 1 })) as HistorySeries;
    expect(out.series.proposals_rerouted[0]!.count).toBe(1);
    expect(out.series.proposals_staged[0]!.count).toBe(1);
  });
});
