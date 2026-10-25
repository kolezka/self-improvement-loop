import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fsx, paths, StateReadError, StateWriteError } from "@sil/core";
import { closeState, openState, readDoc, saveDoc } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-docs-"));
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

const backups = (path: string): string[] => readdirSync(dirname(path)).filter((name) => name.startsWith(`${basename(path)}.imported-`));

const stateLogLines = (): string[] => readFileSync(paths.logFile("state"), "utf8").split("\n").filter((l) => l.length > 0);

function quarantineRow(store: string, world: string | null): void {
  openState()
    .query("INSERT INTO quarantine (store, world, source, line_no, reason, raw, quarantined_at) VALUES (?, ?, 'src', NULL, 'not JSON', 'x', 't')")
    .run(store, world);
}

describe("readDoc and saveDoc", () => {
  test("a saved document reads back strict", () => {
    saveDoc("worker_status", null, { state: "idle", runs: [1, 2] });
    saveDoc("refine_attempts", "a", { "p-1": 2 });
    expect(readDoc("worker_status", null, "strict")).toEqual({ state: "idle", runs: [1, 2] });
    expect(readDoc("refine_attempts", "a", "strict")).toEqual({ "p-1": 2 });
    saveDoc("worker_status", null, { state: "busy" });
    expect(readDoc("worker_status", null, "strict")).toEqual({ state: "busy" });
  });

  test("a row whose body is not a JSON object is malformed, not missing", () => {
    saveDoc("worker_status", null, { last_run: "t" });
    expect(readDoc("worker_status", null, "strict")).toEqual({ last_run: "t" });
    for (const body of ["null", "[1]", "7"]) {
      openState().query("UPDATE docs SET body = ? WHERE name = 'worker_status'").run(body);
      const error = caught(() => readDoc("worker_status", null, "strict"));
      expect(error).toBeInstanceOf(StateReadError);
      expect((error as Error).message).toBe("the worker status is not a JSON object");
    }
    expect(readDoc("worker_status", null, "tolerant")).toBeNull();
    expect(readDoc("worker_status", null, "tolerant")).toBeNull();
    const lines = stateLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the worker status: tolerant read used what the database has (not a JSON object)");
  });

  test("no row reads as null in both modes", () => {
    expect(readDoc("queue_cleared", null, "strict")).toBeNull();
    expect(readDoc("queue_cleared", null, "tolerant")).toBeNull();
    expect(readDoc("refine_attempts", "a", "strict")).toBeNull();
  });

  test("a legacy file waiting at the old path is imported before saveDoc writes", () => {
    // Open first, so the first-open import cannot pick the file up on saveDoc's behalf.
    openState();
    const legacy = paths.queueClearedFile();
    fsx.ensureDir(dirname(legacy));
    writeFileSync(legacy, JSON.stringify({ default: "2026-01-01T00:00:00Z" }));
    saveDoc("queue_cleared", null, { default: "2026-10-25T00:00:00Z" });
    // saved value wins
    expect(readDoc("queue_cleared", null, "strict")).toEqual({ default: "2026-10-25T00:00:00Z" });
    expect(backups(legacy)).toHaveLength(1);
  });

  test("a quarantine row: strict throws the quarantine message, tolerant is null and logs once", () => {
    quarantineRow("queue_cleared", null);
    const error = caught(() => readDoc("queue_cleared", null, "strict"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toBe("the queue cutoffs could not be imported; see sil state quarantine");
    expect(readDoc("queue_cleared", null, "tolerant")).toBeNull();
    expect(readDoc("queue_cleared", null, "tolerant")).toBeNull();
    const lines = stateLogLines();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("the queue cutoffs");
  });

  test("a quarantine row for one world leaves another world readable", () => {
    saveDoc("refine_attempts", "b", { x: 1 });
    quarantineRow("refine_attempts", "a");
    expect(caught(() => readDoc("refine_attempts", "a", "strict"))).toBeInstanceOf(StateReadError);
    expect(readDoc("refine_attempts", "b", "strict")).toEqual({ x: 1 });
  });

  test("a directory in the database's place: strict throws naming the label, tolerant is null", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    const error = caught(() => readDoc("worker_status", null, "strict"));
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message.startsWith("the worker status cannot be read (")).toBe(true);
    expect(readDoc("worker_status", null, "tolerant")).toBeNull();
  });

  test("saveDoc on a broken database throws StateWriteError starting with the label", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    const error = caught(() => saveDoc("refine_attempts", "a", { x: 1 }));
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message.startsWith('the refine attempts of world "a" ')).toBe(true);
  });
});
