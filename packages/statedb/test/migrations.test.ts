import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, StateWriteError } from "@sil/core";
import { closeState, MIGRATIONS, openState, SCHEMA_VERSION } from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-migrations-"));
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

const pragma = (db: Database, name: string): unknown => Object.values(db.query(`PRAGMA ${name}`).get() as object)[0];
const tables = (db: Database): string[] =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
const columns = (db: Database, table: string): string[] =>
  (db.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((r) => r.name);

const INDEX_COLUMNS = [
  "path", "dir_world", "id", "world", "pattern", "session_id", "created", "created_at",
  "head", "size", "mtime_ms", "ino", "indexed_at",
];

function rawDb(): Database {
  const p = paths.loopStateDb();
  mkdirSync(dirname(p), { recursive: true });
  return new Database(p, { create: true });
}

describe("schema v4", () => {
  test("a v1 database upgrades to v4 and keeps its rows", () => {
    const raw = rawDb();
    try {
      MIGRATIONS[0]!.up(raw);
      raw.run("PRAGMA user_version = 1");
      raw.run("INSERT INTO meta (key, value) VALUES ('created_at', '2026-01-01T00:00:00.000Z')");
      raw.run(
        "INSERT INTO legacy_imports (id, store, original_path, state, lines_imported, started_at) VALUES (7, 'critic', '/old/critic.jsonl', 'verified', 1, 's')",
      );
      raw.run(
        `INSERT INTO log_records (id, stream, ts, world, body, recorded_at, import_id) VALUES (3, 'critic', 't1', 'w', '{"ts":"t1","world":"w"}', 'r1', 7)`,
      );
      raw.run(
        "INSERT INTO quarantine (id, store, source, import_id, line_no, reason, raw, quarantined_at) VALUES (5, 'critic', '/old/critic.jsonl', 7, 2, 'not JSON', 'oops', 'q1')",
      );
    } finally {
      raw.close();
    }

    const db = openState();
    // The ladder runs on to the current version; this test pins what the upgrade kept.
    expect(pragma(db, "user_version")).toBe(4);
    expect(tables(db)).toContain("docs");
    expect(tables(db)).toContain("aliases");
    expect(columns(db, "quarantine")).toContain("world");
    expect(columns(db, "reflection_index")).toEqual(INDEX_COLUMNS);
    expect(db.query("SELECT value FROM meta WHERE key = 'created_at'").get()).toEqual({ value: "2026-01-01T00:00:00.000Z" });
    expect(db.query("SELECT id, store, original_path, state, lines_imported, started_at FROM legacy_imports").all()).toEqual([
      { id: 7, store: "critic", original_path: "/old/critic.jsonl", state: "verified", lines_imported: 1, started_at: "s" },
    ]);
    expect(db.query("SELECT id, stream, ts, world, body, recorded_at, import_id FROM log_records").all()).toEqual([
      { id: 3, stream: "critic", ts: "t1", world: "w", body: '{"ts":"t1","world":"w"}', recorded_at: "r1", import_id: 7 },
    ]);
    expect(db.query("SELECT id, store, source, import_id, line_no, reason, raw, quarantined_at, world FROM quarantine").all()).toEqual([
      { id: 5, store: "critic", source: "/old/critic.jsonl", import_id: 7, line_no: 2, reason: "not JSON", raw: "oops", quarantined_at: "q1", world: null },
    ]);
  });

  test("a fresh database is v4 with the reflection index", () => {
    const db = openState();
    expect(pragma(db, "user_version")).toBe(4);
    expect(tables(db)).toContain("docs");
    expect(tables(db)).toContain("aliases");
    expect(columns(db, "docs")).toEqual(["name", "world", "body", "updated_at"]);
    expect(columns(db, "aliases")).toEqual(["world", "alias", "canonical"]);
    expect(columns(db, "quarantine")).toContain("world");
    expect(columns(db, "reflection_index")).toEqual(INDEX_COLUMNS);
    const indexes = db.query("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'reflection_index' AND sql IS NOT NULL").all();
    expect(indexes).toEqual([{ name: "reflection_index_world" }]);
  });
});

const indexes = (db: Database): string[] =>
  (db.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as { name: string }[]).map((r) => r.name);

describe("schema v3", () => {
  test("a v2 database upgrades through v3 to v4 and keeps its rows", () => {
    const raw = rawDb();
    try {
      MIGRATIONS[0]!.up(raw);
      MIGRATIONS[1]!.up(raw);
      raw.run("PRAGMA user_version = 2");
      raw.run(
        "INSERT INTO legacy_imports (id, store, world, original_path, state, lines_imported, started_at) VALUES (7, 'refine_attempts', 'w', '/old/w.json', 'verified', 1, 's')",
      );
      raw.run(
        `INSERT INTO log_records (id, stream, ts, world, body, recorded_at, import_id) VALUES (3, 'critic', 't1', 'w', '{"ts":"t1","world":"w"}', 'r1', 7)`,
      );
      raw.run(
        "INSERT INTO quarantine (id, store, source, import_id, line_no, reason, raw, quarantined_at, world) VALUES (5, 'refine_attempts', '/old/w.json', 7, NULL, 'not JSON', 'oops', 'q1', 'w')",
      );
      raw.run(`INSERT INTO docs (name, world, body, updated_at) VALUES ('worker_status', '', '{"state":"idle"}', 'u1')`);
      raw.run("INSERT INTO aliases (world, alias, canonical) VALUES ('w', 'old', 'new')");
    } finally {
      raw.close();
    }

    const db = openState();
    expect(pragma(db, "user_version")).toBe(4);
    expect(indexes(db)).toContain("log_records_usage_ref");
    expect(tables(db)).toContain("reflection_index");
    expect(db.query("SELECT id, store, world, original_path, state, lines_imported, started_at FROM legacy_imports").all()).toEqual([
      { id: 7, store: "refine_attempts", world: "w", original_path: "/old/w.json", state: "verified", lines_imported: 1, started_at: "s" },
    ]);
    expect(db.query("SELECT id, stream, ts, world, body, recorded_at, import_id FROM log_records").all()).toEqual([
      { id: 3, stream: "critic", ts: "t1", world: "w", body: '{"ts":"t1","world":"w"}', recorded_at: "r1", import_id: 7 },
    ]);
    expect(db.query("SELECT id, store, source, import_id, line_no, reason, raw, quarantined_at, world FROM quarantine").all()).toEqual([
      { id: 5, store: "refine_attempts", source: "/old/w.json", import_id: 7, line_no: null, reason: "not JSON", raw: "oops", quarantined_at: "q1", world: "w" },
    ]);
    expect(db.query("SELECT name, world, body, updated_at FROM docs").all()).toEqual([
      { name: "worker_status", world: "", body: '{"state":"idle"}', updated_at: "u1" },
    ]);
    expect(db.query("SELECT world, alias, canonical FROM aliases").all()).toEqual([{ world: "w", alias: "old", canonical: "new" }]);
  });

  test("a fresh database has the usage index", () => {
    const db = openState();
    expect(indexes(db)).toContain("log_records_usage_ref");
    expect(pragma(db, "user_version")).toBe(4);
  });

  test("a v5 database is refused", () => {
    const raw = rawDb();
    try {
      raw.run("PRAGMA user_version = 5");
    } finally {
      raw.close();
    }
    expect(() => openState()).toThrow(new StateWriteError("loop state was written by a newer sil (schema 5, this build knows 4)"));
  });

  test("the last ladder step is the build's version", () => {
    expect(MIGRATIONS.at(-1)!.version).toBe(SCHEMA_VERSION);
  });

  // Phase 3 and phase 4 were built on parallel branches that each added one
  // step; a gap here would leave a database upgraded by one branch's build
  // without the other's step forever.
  test("the ladder is contiguous from 1 to the build's version", () => {
    expect(MIGRATIONS.map((m) => m.version)).toEqual(Array.from({ length: SCHEMA_VERSION }, (_, i) => i + 1));
  });
});
