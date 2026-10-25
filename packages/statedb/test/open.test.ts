import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { paths, StateWriteError } from "@sil/core";
import * as fsProbe from "@sil/core/fs-probe";
import type { FilesystemClass } from "@sil/core/fs-probe";
import { closeState, openState, SCHEMA_VERSION } from "../src/index.ts";
import { checkSameDevice, connect, prepare, type Probe, recordProbe } from "../src/open.ts";

// mock.module stays registered for the whole bun test process, so the stub
// delegates to the real probe unless a test forces a class.
const realFsProbe = { ...fsProbe };
let forcedClass: FilesystemClass | null = null;
mock.module("@sil/core/fs-probe", () => ({
  ...realFsProbe,
  probeFilesystem: (path: string): FilesystemClass => forcedClass ?? realFsProbe.probeFilesystem(path),
}));

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-open-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  forcedClass = null;
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

describe("openState", () => {
  test("creates a missing database at version 1 in WAL mode with every v1 table", () => {
    const p = paths.loopStateDb();
    expect(existsSync(p)).toBe(false);
    const db = openState();
    expect(existsSync(p)).toBe(true);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(pragma(db, "user_version")).toBe(1);
    expect(SCHEMA_VERSION).toBe(1);
    expect(pragma(db, "journal_mode")).toBe("wal");
    expect(pragma(db, "synchronous")).toBe(2);
    expect(pragma(db, "busy_timeout")).toBe(2000);
    expect(pragma(db, "foreign_keys")).toBe(1);
    const tables = (db.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((r) => r.name);
    for (const t of ["meta", "log_records", "legacy_imports", "quarantine"]) expect(tables).toContain(t);
    const meta = new Map((db.query("SELECT key, value FROM meta").all() as { key: string; value: string }[]).map((r) => [r.key, r.value]));
    expect(meta.get("fs_class")).toBe("local");
    expect(meta.get("fs_dev")).toBe(String(statSync(dirname(p)).dev));
    expect(meta.has("created_at")).toBe(true);
    expect(meta.has("fs_probed_at")).toBe(true);
  });

  test("reopen after closeState keeps rows on a new handle", () => {
    const first = openState();
    first.run("INSERT INTO meta (key, value) VALUES ('probe', 'kept')");
    closeState();
    const second = openState();
    expect(second).not.toBe(first);
    const row = second.query("SELECT value FROM meta WHERE key = 'probe'").get() as { value: string } | null;
    expect(row?.value).toBe("kept");
  });

  test("refuses a database written by a newer schema", () => {
    const p = paths.loopStateDb();
    mkdirSync(dirname(p), { recursive: true });
    // A plausible newer file: it has the v1 tables, so only the version check can refuse it.
    const raw = new Database(p);
    try {
      raw.run("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
      raw.run("PRAGMA user_version = 2");
    } finally {
      raw.close();
    }
    expect(() => openState()).toThrow(StateWriteError);
    expect(() => openState()).toThrow(new StateWriteError("loop state was written by a newer sil (schema 2, this build knows 1)"));
    const after = new Database(p, { readonly: true });
    try {
      expect(after.query("SELECT count(*) AS n FROM meta").get()).toEqual({ n: 0 });
    } finally {
      after.close();
    }
  });

  test("switching SIL_STATE_DIR returns a different handle to a different file", () => {
    const first = openState();
    const firstPath = paths.loopStateDb();
    process.env.SIL_STATE_DIR = join(tmp, "other-state");
    const second = openState();
    const secondPath = paths.loopStateDb();
    expect(secondPath).not.toBe(firstPath);
    expect(second).not.toBe(first);
    expect(existsSync(firstPath)).toBe(true);
    expect(existsSync(secondPath)).toBe(true);
    expect(first.filename).toBe(firstPath);
    expect(second.filename).toBe(secondPath);
    expect(openState()).toBe(second);
  });

  test("a directory in the database's place raises StateWriteError", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    expect(() => openState()).toThrow(StateWriteError);
  });

  test("a non-local filesystem is refused", () => {
    forcedClass = "unsupported";
    expect(() => openState()).toThrow(StateWriteError);
    expect(() => openState()).toThrow(/unsupported filesystem/);
    expect(existsSync(paths.loopStateDb())).toBe(false);
  });

  test("an unknown filesystem is refused the same way", () => {
    forcedClass = "unknown";
    expect(() => openState()).toThrow(/unsupported filesystem/);
  });

  test("recordProbe refuses a version raised after the handle was prepared", () => {
    openState();
    closeState();
    const p = paths.loopStateDb();
    const db = connect(p);
    try {
      prepare(db);
      const metaRows = () => db.query("SELECT key, value FROM meta ORDER BY key").all();
      const before = metaRows();
      // Another process upgrades the file between prepare and the metadata write.
      const raw = new Database(p);
      try {
        raw.run("PRAGMA user_version = 2");
      } finally {
        raw.close();
      }
      const probe: Probe = { fsClass: "local", dev: 12345, at: "2000-01-01T00:00:00.000Z" };
      expect(() => recordProbe(db, probe)).toThrow(new StateWriteError("loop state was written by a newer sil (schema 2, this build knows 1)"));
      expect(metaRows()).toEqual(before);
    } finally {
      db.close();
    }
  });
});

describe("checkSameDevice", () => {
  test("refuses a dir whose device differs from the probed one", () => {
    const dev = statSync(tmp).dev;
    const probe = (d: number): Probe => ({ fsClass: "local", dev: d, at: new Date().toISOString() });
    expect(() => checkSameDevice(tmp, probe(dev + 1))).toThrow(new StateWriteError("loop state: unsupported filesystem (device changed since probe)"));
    expect(() => checkSameDevice(tmp, probe(dev))).not.toThrow();
  });
});
