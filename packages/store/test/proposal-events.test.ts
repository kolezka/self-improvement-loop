import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, StateReadError } from "@sil/core";
import { closeState } from "@sil/statedb";
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
  closeState();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function seedLegacy(text: string): void {
  const file = paths.proposalEventsFile();
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, text);
}

const legacyLine = (event: string): string => `${JSON.stringify({ ts: "2026-10-01T00:00:00.000Z", world: "default", pattern: "p-one", event })}\n`;

/** A directory where the database file goes: openState fails through the real
 * path, the same way a broken mount or a refused file would. */
function blockDatabase(): void {
  mkdirSync(paths.loopStateDb(), { recursive: true });
}

describe("proposal events", () => {
  test("append then read round-trips and counts a line the import refused as skipped", () => {
    seedLegacy(legacyLine("staged") + "not json\n");
    appendProposalEvent("default", "p-one", "accepted");
    const { events, skipped } = readProposalEvents();
    expect(events.map((e) => e.event)).toEqual(["staged", "accepted"]);
    expect(skipped).toBe(1);
  });

  test("a JSON object that fails the schema is counted as skipped, not dropped", () => {
    seedLegacy(legacyLine("staged") + `${JSON.stringify({ event: "bogus" })}\n`);
    const { events, skipped } = readProposalEvents();
    expect(events.map((e) => e.event)).toEqual(["staged"]);
    expect(skipped).toBe(1);
  });

  test("quarantined and schema-invalid lines add up", () => {
    seedLegacy(`not json\n${JSON.stringify({ event: "bogus" })}\n${legacyLine("revised")}`);
    expect(readProposalEvents()).toMatchObject({ events: [{ event: "revised" }], skipped: 2 });
  });

  test("missing log reads as empty, not an error", () => {
    expect(readProposalEvents()).toEqual({ events: [], skipped: 0 });
  });

  test("an unreadable database throws StateReadError naming the log, never reads as empty", () => {
    blockDatabase();
    let error: unknown = null;
    try {
      readProposalEvents();
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message.startsWith("the proposal events log cannot be read (")).toBe(true);
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
    blockDatabase();
    const result = recordProposalEvent("default", "p-one", "accepted");
    expect(result).not.toBeNull();
    expect(result!.startsWith("the proposal events log")).toBe(true);

    const curriculumLog = readFileSync(paths.logFile("curriculum"), "utf8");
    expect(curriculumLog).toContain("ERROR proposal event accepted default/p-one");
  });

  test("a write failure whose own fallback log write also fails does not throw", () => {
    if (process.getuid?.() === 0) return; // root ignores file permissions
    // A disk-full condition, or the same broken mount, can hit both the
    // database and the log the fallback writes to; the fallback must not
    // turn that into a second, unhandled throw.
    blockDatabase();
    const logsDir = dirname(paths.logFile("curriculum"));
    mkdirSync(logsDir, { recursive: true });
    chmodSync(logsDir, 0o000);
    try {
      const result = recordProposalEvent("default", "p-one", "accepted");
      expect(result).not.toBeNull();
      expect(result!.startsWith("the proposal events log")).toBe(true);
    } finally {
      chmodSync(logsDir, 0o755);
    }
  });
});
