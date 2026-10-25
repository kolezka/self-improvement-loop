import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths } from "@sil/core";
import { closeState, dropQuarantine, exportLegacy, listQuarantine, openState, replaceAliases, saveDoc, stateStatus } from "../src/index.ts";

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
      { store: "critic", world: null, state: "failed", backupPath: null, failure: "boom", lines: 0, backupCheck: null, grewBytes: null },
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
    expect(listQuarantine("human")).toEqual([{ id: 2, store: "human", world: null, source: "src", lineNo: 2, reason: "not JSON" }]);
    expect(dropQuarantine("critic")).toBe(1);
    expect(listQuarantine().map((q) => q.store)).toEqual(["human"]);
  });
});

const quarantineRow = (store: string, world: string | null): void => {
  openState()
    .query("INSERT INTO quarantine (store, world, source, line_no, reason, raw, quarantined_at) VALUES (?, ?, 'src', NULL, 'not JSON', 'x', 't')")
    .run(store, world);
};

describe("documents and aliases in status and quarantine", () => {
  test("stateStatus lists each document and aliases world it has seen", () => {
    saveDoc("worker_status", null, { state: "idle" });
    replaceAliases("default", { a: "b", c: "d" });
    const { docs } = stateStatus();
    expect(docs).toContainEqual({ store: "worker_status", world: null, rows: 1, quarantined: 0, pending: false });
    expect(docs).toContainEqual({ store: "aliases", world: "default", rows: 2, quarantined: 0, pending: false });
  });

  test("listQuarantine returns the world of a per-world row", () => {
    quarantineRow("aliases", "a");
    quarantineRow("critic", null);
    expect(listQuarantine("aliases")).toEqual([{ id: 1, store: "aliases", world: "a", source: "src", lineNo: null, reason: "not JSON" }]);
  });

  test("dropQuarantine drops every world without a world, one world with it", () => {
    quarantineRow("refine_attempts", "a");
    quarantineRow("refine_attempts", "b");
    expect(dropQuarantine("refine_attempts")).toBe(2);
    expect(listQuarantine("refine_attempts")).toEqual([]);
    quarantineRow("refine_attempts", "a");
    quarantineRow("refine_attempts", "b");
    expect(dropQuarantine("refine_attempts", "a")).toBe(1);
    expect(listQuarantine("refine_attempts").map((q) => q.world)).toEqual(["b"]);
  });

  test("exportLegacy writes documents and aliases in writeJson format and records export rows", () => {
    saveDoc("queue_cleared", null, { default: "2026-10-25T00:00:00Z" });
    replaceAliases("default", { zeta: "z", alpha: "a" });
    const result = exportLegacy(false);
    expect(result.failures).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.written.sort()).toEqual([paths.aliasesFile("default"), paths.queueClearedFile()].sort());
    expect(readFileSync(paths.queueClearedFile(), "utf8")).toBe(`${JSON.stringify({ default: "2026-10-25T00:00:00Z" }, null, 2)}\n`);
    expect(readFileSync(paths.aliasesFile("default"), "utf8")).toBe(`${JSON.stringify({ alpha: "a", zeta: "z" }, null, 2)}\n`);
    const rows = openState()
      .query("SELECT store, world, original_path AS path FROM legacy_imports WHERE origin = 'export' ORDER BY store")
      .all();
    expect(rows).toEqual([
      { store: "aliases", world: "default", path: paths.aliasesFile("default") },
      { store: "queue_cleared", world: null, path: paths.queueClearedFile() },
    ]);
  });

  test("exportLegacy refuses a quarantined document world and still exports the others", () => {
    saveDoc("refine_attempts", "b", { x: 1 });
    quarantineRow("refine_attempts", "a");
    const result = exportLegacy(false);
    expect(result.failures).toEqual([
      { store: "refine_attempts", world: "a", message: 'the refine attempts of world "a" could not be imported; see sil state quarantine' },
    ]);
    expect(result.written).toEqual([paths.refineAttemptsFile("b")]);
  });

  test("a forced export of an emptied aliases world replaces its exported file with {}", () => {
    replaceAliases("default", { a: "b" });
    expect(exportLegacy(false).written).toEqual([paths.aliasesFile("default")]);
    replaceAliases("default", {});
    const result = exportLegacy(true);
    expect(result.failures).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.written).toEqual([paths.aliasesFile("default")]);
    expect(readFileSync(paths.aliasesFile("default"), "utf8")).toBe("{}\n");
    const rows = openState()
      .query("SELECT world, lines_imported AS lines, size FROM legacy_imports WHERE origin = 'export' AND store = 'aliases' ORDER BY id")
      .all();
    expect(rows).toEqual([
      { world: "default", lines: 1, size: Buffer.byteLength(`${JSON.stringify({ a: "b" }, null, 2)}\n`) },
      { world: "default", lines: 0, size: 3 },
    ]);
  });

  test("an emptied aliases world without --force refuses the existing file", () => {
    replaceAliases("default", { a: "b" });
    exportLegacy(false);
    replaceAliases("default", {});
    const result = exportLegacy(false);
    expect(result.refused).toEqual([{ path: paths.aliasesFile("default"), message: `${paths.aliasesFile("default")} already exists; pass --force to overwrite it` }]);
    expect(readFileSync(paths.aliasesFile("default"), "utf8")).toBe(`${JSON.stringify({ a: "b" }, null, 2)}\n`);
  });

  test("an aliases export keeps a __proto__ row", () => {
    replaceAliases("default", { safe: "s" });
    openState().query("INSERT INTO aliases (world, alias, canonical) VALUES ('default', '__proto__', 'x')").run();
    exportLegacy(false);
    const text = readFileSync(paths.aliasesFile("default"), "utf8");
    expect(Object.keys(JSON.parse(text))).toEqual(["__proto__", "safe"]);
  });

  test("a forced export refuses a recorded document file whose row is gone", () => {
    saveDoc("queue_cleared", null, { default: "t" });
    exportLegacy(false);
    openState().query("DELETE FROM docs WHERE name = 'queue_cleared'").run();
    const result = exportLegacy(true);
    expect(result.refused).toEqual([
      { path: paths.queueClearedFile(), message: `${paths.queueClearedFile()} holds the queue cutoffs, which no longer exists in the loop state` },
    ]);
    expect(readFileSync(paths.queueClearedFile(), "utf8")).toBe(`${JSON.stringify({ default: "t" }, null, 2)}\n`);
  });
});
