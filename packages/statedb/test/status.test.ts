import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, StateReadError } from "@sil/core";
import { appendRecord, closeState, dropQuarantine, exportLegacy, listQuarantine, openState, replaceAliases, saveDoc, stateStatus } from "../src/index.ts";

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

function importRow(state: "verified" | "failed", dev: number | null, ino: number | null, failure: string | null = null, originalPath = "/x"): void {
  openState()
    .query("INSERT INTO legacy_imports (store, original_path, state, failure, dev, ino, started_at) VALUES ('critic', ?, ?, ?, ?, ?, 't')")
    .run(originalPath, state, failure, dev, ino);
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
      { store: "critic", world: null, state: "failed", originalPath: "/x", backupPath: null, failure: "boom", lines: 0, backupCheck: null, grewBytes: null },
    ]);
  });

  test("a failed segment import names the segment it came from", () => {
    const segment = `${paths.criticFeedbackFile()}.spill/20261026T000000000Z-1-0.jsonl`;
    importRow("failed", null, null, "EIO", segment);
    expect(stateStatus().imports.map((i) => [i.state, i.originalPath, i.failure])).toEqual([["failed", segment, "EIO"]]);
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

  test("exportLegacy imports a legacy-only payload world on an already open connection and writes it back", () => {
    openState();
    const target = paths.payloadSamplesFile("late");
    mkdirSync(dirname(target), { recursive: true });
    const bytes = '{"world":"late","tool_name":"Bash"}\n';
    writeFileSync(target, bytes);
    const result = exportLegacy(false);
    expect(result.failures).toEqual([]);
    expect(result.refused).toEqual([]);
    expect(result.written).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe(bytes);
    const rows = openState().query("SELECT store, world, original_path AS path FROM legacy_imports WHERE origin = 'export'").all();
    expect(rows).toEqual([{ store: "payload_samples", world: "late", path: target }]);
  });

  test("exportLegacy refuses payload worlds whose names are not path-safe", () => {
    appendRecord("payload_samples", { world: "a/b", marker: "unsafe" }, "default");
    appendRecord("payload_samples", { world: "a_b", marker: "safe" }, "default");

    const target = paths.payloadSamplesFile("a_b");
    const result = exportLegacy(false);

    expect(result.failures).toEqual([]);
    expect(result.refused).toEqual([
      {
        store: "payload_samples",
        world: "a/b",
        path: target,
        message: 'the payload samples of world "a/b": world name is not path-safe',
      },
    ]);
    expect(result.written).toEqual([target]);
    expect(readFileSync(target, "utf8")).toBe('{"world":"a_b","marker":"safe"}\n');
  });

  test("exportLegacy refuses every payload world whose path collides by case", () => {
    appendRecord("payload_samples", { world: "A", marker: "upper" }, "default");
    appendRecord("payload_samples", { world: "a", marker: "lower" }, "default");

    const upperPath = paths.payloadSamplesFile("A");
    const lowerPath = paths.payloadSamplesFile("a");
    const result = exportLegacy(false);

    expect(result.failures).toEqual([]);
    expect(result.refused).toEqual([
      {
        store: "payload_samples",
        world: "A",
        path: upperPath,
        message: 'the payload samples of world "A": world names collide on a case-insensitive filesystem: A, a',
      },
      {
        store: "payload_samples",
        world: "a",
        path: lowerPath,
        message: 'the payload samples of world "a": world names collide on a case-insensitive filesystem: A, a',
      },
    ]);
    expect(result.written).toEqual([]);
    expect(existsSync(upperPath)).toBe(false);
    expect(existsSync(lowerPath)).toBe(false);
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
    expect(result.refused).toEqual([{ store: "aliases", world: "default", path: paths.aliasesFile("default"), message: `${paths.aliasesFile("default")} already exists; pass --force to overwrite it` }]);
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
      { store: "queue_cleared", world: null, path: paths.queueClearedFile(), message: `${paths.queueClearedFile()} holds the queue cutoffs, which no longer exists in the loop state` },
    ]);
    expect(readFileSync(paths.queueClearedFile(), "utf8")).toBe(`${JSON.stringify({ default: "t" }, null, 2)}\n`);
  });

  test("a forced export refuses an unrecorded aliases file of a world with no loop-state trace", () => {
    // The doc export suspends legacy imports, so the aliases file below stays where it is.
    saveDoc("queue_cleared", null, { default: "t" });
    expect(exportLegacy(false).written).toEqual([paths.queueClearedFile()]);
    const target = paths.aliasesFile("default");
    mkdirSync(dirname(target), { recursive: true });
    const bytes = `${JSON.stringify({ x: "y" }, null, 2)}\n`;
    writeFileSync(target, bytes);
    const result = exportLegacy(true);
    expect(result.refused).toContainEqual({ store: "aliases", world: "default", path: target, message: `${target} has lines that are not in the loop state; run sil state migrate first` });
    expect(readFileSync(target, "utf8")).toBe(bytes);
  });

  test("an export with a world dir that cannot be listed throws StateReadError", () => {
    const worldDir = dirname(paths.aliasesFile("default"));
    mkdirSync(worldDir, { recursive: true });
    chmodSync(worldDir, 0o000);
    let error: unknown = null;
    try {
      exportLegacy(false);
    } catch (caughtError) {
      error = caughtError;
    } finally {
      chmodSync(worldDir, 0o755);
    }
    expect(error).toBeInstanceOf(StateReadError);
    expect((error as Error).message).toContain("the legacy aliases files cannot be listed (");
  });
});

describe("payload samples in status", () => {
  test("worldStreams lists each world from rows and legacy files, with counts and pending", () => {
    const db = openState();
    db.run(
      `INSERT INTO log_records (stream, ts, world, body, recorded_at) VALUES ('payload_samples', 't', 'beta', '{"world":"beta"}', 'r'), ('critic', 't', 'gamma', '{"world":"gamma"}', 'r')`,
    );
    db.run("INSERT INTO quarantine (store, source, reason, raw, quarantined_at, world) VALUES ('payload_samples', '/x', 'not JSON', 'oops', 'q', 'beta')");
    const legacy = paths.payloadSamplesFile("alpha");
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(legacy, '{"n":1}\n');
    writeFileSync(join(dirname(legacy), "a b.jsonl"), '{"n":1}\n');
    const status = stateStatus();
    expect(status.worldStreams).toEqual([
      { store: "payload_samples", world: "alpha", rows: 0, quarantined: 0, pending: true },
      { store: "payload_samples", world: "beta", rows: 1, quarantined: 1, pending: false },
    ]);
    expect(status.invalidWorldEntries).toContainEqual({ store: "payload_samples", name: "a b" });
    expect(Object.keys(status.streams)).not.toContain("payload_samples");
    expect(status.streams.usage_events).toEqual({ rows: 0, quarantined: 0, pending: false });
  });

  test("a claim alone is pending", () => {
    // Opened first: the first open imports a claim it finds.
    openState();
    const claim = `${paths.payloadSamplesFile("alpha")}.importing`;
    mkdirSync(dirname(claim), { recursive: true });
    writeFileSync(claim, '{"n":1}\n');
    expect(stateStatus().worldStreams).toEqual([{ store: "payload_samples", world: "alpha", rows: 0, quarantined: 0, pending: true }]);
  });
});

describe("payload samples status edge worlds", () => {
  test("a world with only quarantine rows is listed with its count", () => {
    openState().run(
      "INSERT INTO quarantine (store, source, reason, raw, quarantined_at, world) VALUES ('payload_samples', '/x', 'not JSON', 'oops', 'q', 'orphan')",
    );
    expect(stateStatus().worldStreams).toEqual([{ store: "payload_samples", world: "orphan", rows: 0, quarantined: 1, pending: false }]);
  });

  test("a world with only an import row is listed", () => {
    openState().run(
      "INSERT INTO legacy_imports (store, world, original_path, state, failure, started_at) VALUES ('payload_samples', 'gone', '/x', 'failed', 'EIO', 's')",
    );
    expect(stateStatus().worldStreams).toEqual([{ store: "payload_samples", world: "gone", rows: 0, quarantined: 0, pending: false }]);
  });

  test("a spill path that cannot be listed fails status as StateReadError", () => {
    openState().run(`INSERT INTO log_records (stream, ts, world, body, recorded_at) VALUES ('payload_samples', 't', 'sp', '{"world":"sp"}', 'r')`);
    const spill = `${paths.payloadSamplesFile("sp")}.spill`;
    mkdirSync(dirname(spill), { recursive: true });
    writeFileSync(spill, "not a dir");
    expect(() => stateStatus()).toThrow(new StateReadError('the payload samples of world "sp" cannot be checked (ENOTDIR)'));
  });

  test("a spill dir with a segment or a claim is pending; empty or backups only is not", () => {
    const spill = `${paths.payloadSamplesFile("sp")}.spill`;
    mkdirSync(spill, { recursive: true });
    const pending = (): boolean | undefined => stateStatus().worldStreams.find((w) => w.world === "sp")?.pending;
    // No-spill control: the world is known by its dir, nothing waits in it.
    expect(pending()).toBe(false);
    writeFileSync(join(spill, "x.jsonl.imported-1"), "{}\n");
    expect(pending()).toBe(false);
    writeFileSync(join(spill, "20261026T000000000Z-1-1.jsonl.importing"), "{}\n");
    expect(pending()).toBe(true);
    rmSync(join(spill, "20261026T000000000Z-1-1.jsonl.importing"));
    writeFileSync(join(spill, "20261026T000000000Z-1-2.jsonl"), "{}\n");
    expect(pending()).toBe(true);
  });
});
