import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, StateReadError, StateWriteError } from "@sil/core";
import { appendRecord, closeState, exportJsonl, openState, readRecords, replaceStream } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-streams-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

describe("appendRecord and readRecords", () => {
  test("two appends read back strict as equal objects in append order", () => {
    const first = { ts: "2026-10-25T10:00:00Z", world: "default", verdict: "good" };
    const second = { ts: "2026-10-25T09:00:00Z", world: "default", verdict: "bad", nested: { n: 1 } };
    appendRecord("critic", first);
    appendRecord("critic", second);
    expect(readRecords("critic", "strict")).toEqual({ records: [first, second], quarantined: 0 });
    expect(readRecords("human", "strict")).toEqual({ records: [], quarantined: 0 });
  });

  test("appendRecord stores ts, NFC world and the JSON body in their columns", () => {
    appendRecord("human", { ts: "2026-10-25T10:00:00Z", world: "Café" });
    appendRecord("human", { ts: 7, note: "no world" });
    const rows = openState().query("SELECT ts, world, body, import_id FROM log_records WHERE stream = 'human' ORDER BY id").all();
    expect(rows).toEqual([
      { ts: "2026-10-25T10:00:00Z", world: "Café", body: JSON.stringify({ ts: "2026-10-25T10:00:00Z", world: "Café" }), import_id: null },
      { ts: null, world: null, body: JSON.stringify({ ts: 7, note: "no world" }), import_id: null },
    ]);
  });

  test("a missing database reads empty in all three modes", () => {
    expect(existsSync(paths.loopStateDb())).toBe(false);
    for (const mode of ["strict", "counted", "tolerant"] as const) {
      expect(readRecords("critic", mode)).toEqual({ records: [], quarantined: 0 });
    }
  });

  test("a quarantine row fails strict, is counted by counted and ignored by tolerant", () => {
    appendRecord("critic", { a: 1 });
    openState()
      .query("INSERT INTO quarantine (store, source, line_no, reason, raw, quarantined_at) VALUES ('critic', 'seed', 3, 'not JSON', 'oops', 'now')")
      .run();
    const error = caught(() => readRecords("critic", "strict"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toBe("the critic feedback log has 1 line that could not be imported");
    expect(readRecords("critic", "counted")).toEqual({ records: [{ a: 1 }], quarantined: 1 });
    expect(readRecords("critic", "tolerant")).toEqual({ records: [{ a: 1 }], quarantined: 1 });
    // Another store's quarantine does not count here.
    expect(readRecords("human", "strict")).toEqual({ records: [], quarantined: 0 });
  });

  test("two quarantine rows use the plural wording", () => {
    const db = openState();
    for (const n of [1, 2]) {
      db.query("INSERT INTO quarantine (store, source, line_no, reason, raw, quarantined_at) VALUES ('human', 'seed', ?, 'not JSON', 'x', 'now')").run(n);
    }
    const error = caught(() => readRecords("human", "strict"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toBe("the human feedback log has 2 lines that could not be imported");
  });

  test("a directory in the database's place: strict and counted throw naming the label, tolerant logs once", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    for (const mode of ["strict", "counted"] as const) {
      const error = caught(() => readRecords("proposal_events", mode));
      expect(error).toBeInstanceOf(StateReadError);
      expect((error as Error).message.startsWith("the proposal events log cannot be read (")).toBe(true);
    }
    expect(readRecords("proposal_events", "tolerant")).toEqual({ records: [], quarantined: 0 });
    expect(readRecords("proposal_events", "tolerant")).toEqual({ records: [], quarantined: 0 });
    const lines = readFileSync(paths.logFile("state"), "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the proposal events log");
  });

  test("appendRecord on a broken database throws StateWriteError starting with the label", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    const error = caught(() => appendRecord("reflect_runs", { a: 1 }));
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message.startsWith("the reflect runs log ")).toBe(true);
  });
});

describe("exportJsonl and replaceStream", () => {
  const seedQuarantine = (store: string): void => {
    openState()
      .query("INSERT INTO quarantine (store, source, line_no, reason, raw, quarantined_at) VALUES (?, 'seed', 1, 'not JSON', 'oops', 'now')")
      .run(store);
  };

  test("exportJsonl is null for an empty stream and the bodies in id order otherwise", () => {
    expect(exportJsonl("human")).toBeNull();
    appendRecord("human", { ts: "2026-10-25T10:00:00Z", n: 1 });
    appendRecord("human", { ts: "2026-10-25T09:00:00Z", n: 2 });
    expect(exportJsonl("human")).toBe('{"ts":"2026-10-25T10:00:00Z","n":1}\n{"ts":"2026-10-25T09:00:00Z","n":2}\n');
  });

  test("exportJsonl refuses a stream with quarantined lines, even with no rows", () => {
    seedQuarantine("critic");
    const one = caught(() => exportJsonl("critic"));
    expect(one).toBeInstanceOf(StateReadError);
    expect((one as Error).message).toBe("the critic feedback log has 1 quarantined line; see sil state quarantine");
    seedQuarantine("critic");
    expect((caught(() => exportJsonl("critic")) as Error).message).toBe(
      "the critic feedback log has 2 quarantined lines; see sil state quarantine",
    );
    expect(exportJsonl("human")).toBeNull();
  });

  test("replaceStream fills an empty stream with ts and NFC world columns, quarantining bad lines", () => {
    const jsonl = '{"ts":"2026-10-25T10:00:00Z","world":"Cafe\u0301"}\n\nnot json\n[1]\n{"n":2}\n';
    expect(replaceStream("human", jsonl, "/b/state/feedback/human.jsonl", false)).toEqual({ written: true, imported: 2, quarantined: 2 });
    const rows = openState().query("SELECT ts, world, body, import_id FROM log_records WHERE stream = 'human' ORDER BY id").all();
    expect(rows).toEqual([
      { ts: "2026-10-25T10:00:00Z", world: "Caf\u00e9", body: '{"ts":"2026-10-25T10:00:00Z","world":"Cafe\u0301"}', import_id: null },
      { ts: null, world: null, body: '{"n":2}', import_id: null },
    ]);
    const bad = openState().query("SELECT store, source, import_id, line_no, reason, raw FROM quarantine ORDER BY id").all();
    expect(bad).toEqual([
      { store: "human", source: "/b/state/feedback/human.jsonl", import_id: null, line_no: 3, reason: "not JSON", raw: "not json" },
      { store: "human", source: "/b/state/feedback/human.jsonl", import_id: null, line_no: 4, reason: "not a JSON object", raw: "[1]" },
    ]);
  });

  test("replaceStream leaves a stream with rows alone without force and replaces rows and quarantine with it", () => {
    appendRecord("critic", { host: true });
    seedQuarantine("critic");
    appendRecord("human", { other: "stream" });
    expect(replaceStream("critic", '{"bundle":1}\n', "src", false)).toEqual({ written: false, imported: 0, quarantined: 0 });
    expect(readRecords("critic", "counted")).toEqual({ records: [{ host: true }], quarantined: 1 });

    expect(replaceStream("critic", '{"bundle":1}\n{"bundle":2}\n', "src", true)).toEqual({ written: true, imported: 2, quarantined: 0 });
    expect(readRecords("critic", "strict")).toEqual({ records: [{ bundle: 1 }, { bundle: 2 }], quarantined: 0 });
    expect(readRecords("human", "strict").records).toEqual([{ other: "stream" }]);
  });

  test("a legacy file still at the old path counts as host rows", () => {
    // Open first, so the first-open import has already run and only the pending check can see the file.
    openState();
    mkdirSync(dirname(paths.humanFeedbackFile()), { recursive: true });
    writeFileSync(paths.humanFeedbackFile(), '{"legacy":1}\n');
    expect(replaceStream("human", '{"bundle":1}\n', "src", false).written).toBe(false);
    expect(readRecords("human", "strict").records).toEqual([{ legacy: 1 }]);
  });

  test("replaceStream on a broken database throws StateWriteError starting with the label", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    const error = caught(() => replaceStream("human", '{"a":1}\n', "src", true));
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message.startsWith("the human feedback log cannot be written (")).toBe(true);
    const read = caught(() => exportJsonl("human"));
    expect(read).toBeInstanceOf(StateReadError);
    expect((read as Error).message.startsWith("the human feedback log cannot be read (")).toBe(true);
  });
});
