import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { appendProposalEvent, readProposalEvents } from "../src/index.ts";

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
