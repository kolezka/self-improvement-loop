import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths } from "@sil/core";
import { appendProposalEvent, readProposalEvents, recordProposalEvent } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-store-proposal-events-"));
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

describe("proposal events", () => {
  test("append then read round-trips and counts a bad line as skipped", () => {
    appendProposalEvent("default", "p-one", "staged");
    appendFileSync(paths.proposalEventsFile(), "not json\n");
    appendProposalEvent("default", "p-one", "accepted");
    const { events, skipped } = readProposalEvents();
    expect(events.map((e) => e.event)).toEqual(["staged", "accepted"]);
    expect(skipped).toBe(1);
  });

  test("missing file reads as empty, not an error", () => {
    expect(readProposalEvents()).toEqual({ events: [], skipped: 0 });
  });

  test("records world and pattern on each event", () => {
    appendProposalEvent("koleżka", "verify-callsites", "revised");
    const { events } = readProposalEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ world: "koleżka", pattern: "verify-callsites", event: "revised" });
    expect(typeof events[0]!.ts).toBe("string");
  });
});

describe("recordProposalEvent", () => {
  test("on success, returns null and records the event", () => {
    const result = recordProposalEvent("default", "p-one", "staged");
    expect(result).toBeNull();
    expect(readProposalEvents().events).toMatchObject([{ world: "default", pattern: "p-one", event: "staged" }]);
  });

  test("on a write failure, does not throw: logs to curriculum.log and returns the message", () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions

    // Create the events directory first so chmod has something to lock down;
    // appendJsonl's own mkdirSync(recursive) would otherwise just no-op past
    // a missing dir without ever touching a permission check.
    const eventsDir = dirname(paths.proposalEventsFile());
    mkdirSync(eventsDir, { recursive: true });
    chmodSync(eventsDir, 0o000);
    try {
      const result = recordProposalEvent("default", "p-one", "accepted");
      expect(result).not.toBeNull();
      expect(result).toContain("EACCES");

      const curriculumLog = readFileSync(paths.logFile("curriculum"), "utf8");
      expect(curriculumLog).toContain("ERROR proposal event accepted default/p-one");
    } finally {
      chmodSync(eventsDir, 0o755);
    }
  });
});
