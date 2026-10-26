import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, StateReadError, StateWriteError } from "@sil/core";
// A namespace import, so a missing export fails the test, not the module link.
import * as statedb from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-statedb-reflection-index-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  try {
    statedb.closeState();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true });
  }
});

type Upsert = statedb.ReflectionIndexUpsert;

const row = (path: string, over: Partial<Upsert> = {}): Upsert => ({
  path,
  dirWorld: "w",
  id: "r1",
  world: "w",
  pattern: "p",
  sessionId: "s1",
  created: "2026-10-26",
  createdAt: "2026-10-26T10:00:00.000Z",
  head: '{"id":"r1","world":"w"}',
  size: 120,
  mtimeMs: 1761472800123.5,
  ino: 4242,
  ...over,
});

const caught = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe("reflection index rows", () => {
  test("an upserted row reads back with an ISO indexedAt", () => {
    statedb.updateReflectionIndex("w", [row("/r/a.md")], []);
    const rows = statedb.readReflectionIndex("w");
    expect(rows).toHaveLength(1);
    const { indexedAt, ...rest } = rows[0]!;
    expect(rest).toEqual(row("/r/a.md"));
    expect(indexedAt).toMatch(ISO);
  });

  test("rows read back ordered by path", () => {
    statedb.updateReflectionIndex("w", [row("/r/c.md"), row("/r/a.md"), row("/r/b.md")], []);
    expect(statedb.readReflectionIndex("w").map((r) => r.path)).toEqual(["/r/a.md", "/r/b.md", "/r/c.md"]);
  });

  test("an upsert of the same path replaces the row", () => {
    statedb.updateReflectionIndex("w", [row("/r/a.md")], []);
    statedb.updateReflectionIndex("w", [row("/r/a.md", { pattern: "q", sessionId: null, createdAt: null, size: 7 })], []);
    const rows = statedb.readReflectionIndex("w");
    expect(rows.map(({ indexedAt: _, ...rest }) => rest)).toEqual([row("/r/a.md", { pattern: "q", sessionId: null, createdAt: null, size: 7 })]);
  });

  test("a delete removes the row only while its indexedAt is unchanged", () => {
    statedb.updateReflectionIndex("w", [row("/r/a.md"), row("/r/b.md")], []);
    const [a, b] = statedb.readReflectionIndex("w");
    statedb.updateReflectionIndex("w", [], [{ path: b!.path, indexedAt: "2000-01-01T00:00:00.000Z" }]);
    // row still present: a stale indexedAt means another pass rewrote it.
    expect(statedb.readReflectionIndex("w").map((r) => r.path)).toEqual(["/r/a.md", "/r/b.md"]);
    statedb.updateReflectionIndex("w", [], [{ path: a!.path, indexedAt: a!.indexedAt }]);
    expect(statedb.readReflectionIndex("w").map((r) => r.path)).toEqual(["/r/b.md"]);
  });

  test("the world is keyed by its NFC spelling", () => {
    statedb.updateReflectionIndex("koleżka".normalize("NFC"), [row("/r/a.md", { dirWorld: "koleżka" })], []);
    const rows = statedb.readReflectionIndex("koleżka".normalize("NFD"));
    expect(rows.map((r) => [r.path, r.dirWorld])).toEqual([["/r/a.md", "koleżka".normalize("NFC")]]);
  });

  test("rows of one world are invisible to another", () => {
    statedb.updateReflectionIndex("a", [row("/r/a.md", { dirWorld: "a" })], []);
    expect(statedb.readReflectionIndex("b")).toEqual([]);
    expect(statedb.readReflectionIndex("a").map((r) => r.path)).toEqual(["/r/a.md"]);
  });

  test("a head that is not JSON is refused and nothing of the batch is written", () => {
    const error = caught(() => statedb.updateReflectionIndex("w", [row("/r/a.md"), row("/r/b.md", { head: "not json" })], []));
    expect(error).toBeInstanceOf(StateWriteError);
    expect((error as Error).message).toStartWith('the reflections index of world "w" cannot be written (');
    expect(statedb.readReflectionIndex("w")).toEqual([]);
  });

  test("a directory at the database path fails reads as StateReadError and writes as StateWriteError", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    const readError = caught(() => statedb.readReflectionIndex("w"));
    expect(readError).toBeInstanceOf(StateReadError);
    expect((readError as Error).message).toStartWith('the reflections index of world "w" cannot be read (');
    const writeError = caught(() => statedb.updateReflectionIndex("w", [row("/r/a.md")], []));
    expect(writeError).toBeInstanceOf(StateWriteError);
    expect((writeError as Error).message).toStartWith('the reflections index of world "w" cannot be written (');
  });

  test("an update with nothing to do opens nothing", () => {
    mkdirSync(paths.loopStateDb(), { recursive: true });
    expect(caught(() => statedb.updateReflectionIndex("w", [], []))).toBeNull();
  });
});
