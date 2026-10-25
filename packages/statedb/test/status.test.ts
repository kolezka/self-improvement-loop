import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeState, dropQuarantine, listQuarantine, openState, stateStatus } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-status-"));
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

function importRow(state: "verified" | "failed", dev: number | null, ino: number | null, failure: string | null = null): void {
  openState()
    .query("INSERT INTO legacy_imports (store, original_path, state, failure, dev, ino, started_at) VALUES ('critic', '/x', ?, ?, ?, ?, 't')")
    .run(state, failure, dev, ino);
}

describe("stateStatus imports", () => {
  test("a failed row is listed only while no later verified row has the same dev and ino", () => {
    importRow("failed", 1, 10, "healed");
    importRow("verified", 1, 10);
    importRow("failed", 1, 11, "other file");
    importRow("verified", 1, 12);
    importRow("failed", 1, 12, "after the verified one");
    const failures = stateStatus()
      .imports.filter((i) => i.state === "failed")
      .map((i) => i.failure);
    expect(failures).toEqual(["other file", "after the verified one"]);
  });

  test("a failed row has no backup check", () => {
    importRow("failed", 1, 10, "boom");
    expect(stateStatus().imports).toEqual([
      { store: "critic", state: "failed", backupPath: null, failure: "boom", lines: 0, backupCheck: null, grewBytes: null },
    ]);
  });
});

describe("quarantine helpers", () => {
  test("list filters by stream and drop removes only that stream", () => {
    const insert = openState().query(
      "INSERT INTO quarantine (store, source, line_no, reason, raw, quarantined_at) VALUES (?, 'src', ?, 'not JSON', 'x', 't')",
    );
    insert.run("critic", 1);
    insert.run("human", 2);
    expect(listQuarantine().map((q) => q.store)).toEqual(["critic", "human"]);
    expect(listQuarantine("human")).toEqual([{ id: 2, store: "human", source: "src", lineNo: 2, reason: "not JSON" }]);
    expect(dropQuarantine("critic")).toBe(1);
    expect(listQuarantine().map((q) => q.store)).toEqual(["human"]);
  });
});
