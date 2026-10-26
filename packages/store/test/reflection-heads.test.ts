// listReflectionHeads: the reflection metadata served from the reflection_index
// cache (design D12), with the files as the source. Every pass must equal what
// the file readers return, and an index that cannot be used never fails a read.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { paths, StateReadError } from "@sil/core";
import { closeState, openState, readReflectionIndex } from "@sil/statedb";
import {
  listReflectionHeads,
  listReflectionHeadsStrict,
  listReflections,
  listReflectionsStrict,
  parseReflectionStrict,
  patternCounts,
  reflectedSessions,
  saveAliases,
  scanReflectionHeads,
  writeReflection,
} from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const locked: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-reflection-heads-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  closeState();
  for (const p of locked.splice(0)) chmodSync(p, 0o600);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(tmp, { recursive: true, force: true });
});

function lock(p: string): void {
  locked.push(p);
  chmodSync(p, 0o000);
}

function thrown(fn: () => unknown): Error | undefined {
  try {
    fn();
  } catch (err) {
    return err as Error;
  }
  return undefined;
}

// Copied from packages/curriculum/test/fixtures.ts (no cross-package test imports).
function holdLoopStateWriteLock(): () => void {
  openState();
  const db = new Database(paths.loopStateDb(), { readwrite: true, create: false });
  db.run("BEGIN IMMEDIATE");
  return () => {
    try {
      db.run("ROLLBACK");
    } finally {
      db.close();
    }
  };
}

const W = "w";
const body = (pattern: string) => `Pattern: ${pattern}\n\n## Reusable lesson\nDo the thing.\n`;
const raw = (id: string, pattern = "p") => `---\nid: ${id}\ncreated: 2026-10-22\n---\nPattern: ${pattern}\n\nx\n`;
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
const pick = (r: { id: string; pattern: string; created: string; created_at: string | null; session_id: string | null; path: string }) => ({
  id: r.id,
  pattern: r.pattern,
  created: r.created,
  created_at: r.created_at,
  session_id: r.session_id,
  path: r.path,
});

/** Three reflections over two days, in world W's dir. */
function seedThree(world = W): string[] {
  return [
    writeReflection(world, { id: "r1", created: "2026-10-20", created_at: "2026-10-20T10:00:00.000Z", session_id: "s-a" }, body("alpha")),
    writeReflection(world, { id: "r2", created: "2026-10-21", created_at: "2026-10-21T09:00:00.000Z", session_id: "s-b" }, body("beta")),
    writeReflection(world, { id: "r3", created: "2026-10-21", created_at: "2026-10-21T11:00:00.000Z", session_id: null }, body("alpha")),
  ];
}

const stateLogLines = (needle: string): string[] => {
  const file = paths.logFile("state");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.includes(needle));
};

describe("equivalence with the file readers", () => {
  function seedMixed(): void {
    seedThree();
    writeReflection(W, { id: "o1", world: "other", created: "2026-10-22" }, body("gamma"));
    const dir = paths.reflectionsDir(W);
    const outside = join(tmp, "outside");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(dir, "notes.md"), "just notes\n");
    writeFileSync(join(dir, "sub", "a.md"), raw("a"));
    writeFileSync(join(outside, "x.md"), raw("x"));
    symlinkSync("..", join(dir, "sub", "loop"));
    symlinkSync(outside, join(dir, "out"));
  }

  test("heads equal the file readers' records, minus body and lesson, plus the stat mtime", () => {
    seedMixed();
    for (let pass = 0; pass < 2; pass++) {
      const heads = listReflectionHeads(W);
      expect(heads.map(pick)).toEqual(listReflections(W).map(pick));
      expect(listReflectionHeadsStrict(W).map(pick)).toEqual(listReflectionsStrict(W).map(pick));
      expect(ids(heads)).toEqual(["a", "r3", "r2", "r1"]);
      for (const h of heads) {
        expect(Object.hasOwn(h, "body")).toBe(false);
        expect(Object.hasOwn(h, "lesson")).toBe(false);
        expect(h.mtime_ms).toBe(statSync(h.path).mtimeMs);
      }
    }
  });

  test("extraDirs are read like the file readers read them, and only for that pass", () => {
    seedThree();
    const mirror = join(tmp, "mirror");
    mkdirSync(mirror);
    writeFileSync(join(mirror, "m1.md"), raw("m1"));
    expect(listReflectionHeads(W, [mirror]).map(pick)).toEqual(listReflections(W, [mirror]).map(pick));
    expect(listReflectionHeadsStrict(W, [mirror]).map(pick)).toEqual(listReflectionsStrict(W, [mirror]).map(pick));
    expect(ids(listReflectionHeads(W))).toEqual(["r3", "r2", "r1"]);
  });
});

describe("cache hit", () => {
  test.skipIf(process.getuid?.() === 0)("an unchanged file is served from the index without being opened", () => {
    const files = seedThree();
    const notes = join(paths.reflectionsDir(W), "notes.md");
    writeFileSync(notes, "just notes\n");
    expect(ids(listReflectionHeads(W))).toEqual(["r3", "r2", "r1"]);
    for (const f of files) lock(f);
    expect(ids(listReflectionHeads(W))).toEqual(["r3", "r2", "r1"]);
    expect(ids(listReflectionHeadsStrict(W))).toEqual(["r3", "r2", "r1"]);
    const rows = readReflectionIndex(W);
    expect(ids(rows).sort()).toEqual(["r1", "r2", "r3"]);
    expect(rows.some((r) => r.path.endsWith("notes.md"))).toBe(false);
  });
});

describe("change detection", () => {
  test("(a) a rewritten file is parsed again and its row updated", () => {
    seedThree();
    const dir = paths.reflectionsDir(W);
    writeFileSync(join(dir, "c.md"), raw("c", "old-pattern"));
    expect(listReflectionHeads(W).find((h) => h.id === "c")?.pattern).toBe("old-pattern");
    const before = readReflectionIndex(W).find((r) => r.id === "c")!;
    writeFileSync(join(dir, "c.md"), raw("c", "new-pattern"));
    utimesSync(join(dir, "c.md"), new Date(), new Date(Date.now() + 5000));
    expect(listReflectionHeads(W).find((h) => h.id === "c")?.pattern).toBe("new-pattern");
    const after = readReflectionIndex(W).find((r) => r.id === "c")!;
    expect(after.head).not.toBe(before.head);
    expect(after.pattern).toBe("new-pattern");
  });

  test("(b) same bytes, size and mtime on a new inode is parsed again", () => {
    seedThree();
    const dir = paths.reflectionsDir(W);
    const file = join(dir, "c.md");
    writeFileSync(file, raw("c"));
    // A whole-second mtime, so utimes can copy it to the new file exactly.
    utimesSync(file, new Date("2026-10-22T10:00:00Z"), new Date("2026-10-22T10:00:00Z"));
    listReflectionHeads(W);
    const before = readReflectionIndex(W).find((r) => r.id === "c")!;
    const st = statSync(file);
    const next = join(dir, ".c.md.new");
    writeFileSync(next, readFileSync(file));
    utimesSync(next, st.atime, st.mtime);
    renameSync(next, file);
    const now = statSync(file);
    expect([now.size, now.mtimeMs]).toEqual([st.size, st.mtimeMs]);
    expect(now.ino).not.toBe(st.ino);
    Bun.sleepSync(10);
    expect(ids(listReflectionHeads(W))).toContain("c");
    const after = readReflectionIndex(W).find((r) => r.id === "c")!;
    expect(after.indexedAt > before.indexedAt).toBe(true);
    expect(after.ino).toBe(now.ino);
  });

  test("(c) a deleted file loses its row", () => {
    const files = seedThree();
    expect(listReflectionHeads(W)).toHaveLength(3);
    rmSync(files[0]!);
    expect(ids(listReflectionHeads(W))).toEqual(["r3", "r2"]);
    expect(ids(readReflectionIndex(W)).sort()).toEqual(["r2", "r3"]);
  });
});

describe("D10 mtime fallbacks", () => {
  test("a header without created or created_at follows the file's mtime, and so does reflectedSessions", () => {
    const dir = paths.reflectionsDir(W);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "d.md");
    writeFileSync(file, "---\nid: d\nsession_id: s-d\n---\nPattern: p\n\nx\n");
    const first = new Date("2026-01-02T03:04:05Z");
    utimesSync(file, first, first);
    const dates = () => listReflectionHeads(W).map((h) => [h.id, h.created, h.created_at]);
    expect(dates()).toEqual([["d", "2026-01-02", "2026-01-02T03:04:05.000Z"]]);
    const second = new Date("2026-02-03T04:05:06Z");
    utimesSync(file, second, second);
    expect(dates()).toEqual([["d", "2026-02-03", "2026-02-03T04:05:06.000Z"]]);
    expect(reflectedSessions(W).get("s-d")).toBe(statSync(file).mtimeMs);
  });
});

describe("strict and tolerant on a changed file", () => {
  test.skipIf(process.getuid?.() === 0)("an unreadable new file: tolerant omits it, strict names it", () => {
    seedThree();
    listReflectionHeads(W);
    const file = join(paths.reflectionsDir(W), "b.md");
    writeFileSync(file, raw("b"));
    lock(file);
    expect(ids(listReflectionHeads(W))).toEqual(["r3", "r2", "r1"]);
    expect(scanReflectionHeads(W).unreadable).toEqual(["b.md"]);
    const err = thrown(() => listReflectionHeadsStrict(W));
    expect(err).toBeInstanceOf(StateReadError);
    expect(err!.message).toBe(thrown(() => listReflectionsStrict(W))!.message);
  });

  test("an unclosed header: tolerant reads it as the file reader does, strict raises even after a tolerant pass", () => {
    seedThree();
    listReflectionHeads(W);
    const file = join(paths.reflectionsDir(W), "c.md");
    writeFileSync(file, "---\nid: c\nPattern: p\n\nx\n");
    expect(listReflectionHeads(W).map(pick)).toEqual(listReflections(W).map(pick));
    expect(scanReflectionHeads(W).unreadable).toEqual(["c.md"]);
    const err = thrown(() => listReflectionHeadsStrict(W));
    expect(err).toBeInstanceOf(StateReadError);
    expect(err!.message).toBe(thrown(() => listReflectionsStrict(W))!.message);
    // The list message names only the file; the reason is the unclosed header.
    expect(thrown(() => parseReflectionStrict(file, W))!.message).toContain("never closed");
  });
});

describe("a reused row that goes stale", () => {
  test("an indexed file rewritten with an unclosed header: strict names it and its row is gone", () => {
    seedThree();
    const file = join(paths.reflectionsDir(W), "c.md");
    writeFileSync(file, raw("c"));
    listReflectionHeads(W);
    expect(ids(readReflectionIndex(W))).toContain("c");
    writeFileSync(file, "---\nid: c\nPattern: p\n\nx and more\n");
    expect(scanReflectionHeads(W).unreadable).toEqual(["c.md"]);
    expect(ids(readReflectionIndex(W)).sort()).toEqual(["r1", "r2", "r3"]);
  });
});

describe("index unavailable", () => {
  const needle = 'the reflections index of world "w" was not used';
  // One timestamp from logStateLineOnce, then the text.
  const LINE = /^\d{4}-\d{2}-\d{2}T[^ ]+Z the reflections index of world "w" was not used \(.+\); reflections were read from their files$/;
  function expectOneFallbackLine(): void {
    const lines = stateLogLines(needle);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(LINE);
  }

  test("a newer schema: reads come from the files, one log line, the DB untouched", () => {
    seedThree();
    openState();
    listReflectionHeads(W);
    closeState();
    const db = new Database(paths.loopStateDb());
    db.run("PRAGMA user_version = 5");
    db.close();
    writeFileSync(join(paths.reflectionsDir(W), "c.md"), raw("c"));
    expect(ids(listReflectionHeads(W))).toEqual(["c", "r3", "r2", "r1"]);
    expect(ids(listReflectionHeadsStrict(W))).toEqual(["c", "r3", "r2", "r1"]);
    expectOneFallbackLine();
    const check = new Database(paths.loopStateDb(), { readonly: true });
    expect(check.query("PRAGMA user_version").get()).toEqual({ user_version: 5 });
    expect(check.query("SELECT count(*) AS n FROM reflection_index").get()).toEqual({ n: 3 });
    check.close();
  });

  test("a directory at the DB path: reads come from the files, one log line", () => {
    seedThree();
    const dbPath = paths.loopStateDb();
    mkdirSync(join(dbPath, ".."), { recursive: true });
    for (const f of readdirSync(join(dbPath, ".."))) if (f.startsWith("loop-state.sqlite")) rmSync(join(dbPath, "..", f), { recursive: true });
    mkdirSync(dbPath);
    expect(ids(listReflectionHeads(W))).toEqual(["r3", "r2", "r1"]);
    expect(ids(listReflectionHeadsStrict(W))).toEqual(["r3", "r2", "r1"]);
    expectOneFallbackLine();
  });

  test("the write lock held: the pass still returns every file, the next pass stores the row", () => {
    seedThree();
    listReflectionHeads(W);
    writeFileSync(join(paths.reflectionsDir(W), "c.md"), raw("c"));
    const release = holdLoopStateWriteLock();
    let heads;
    const started = Date.now();
    try {
      heads = listReflectionHeads(W);
    } finally {
      release();
    }
    expect(Date.now() - started).toBeLessThan(3000);
    expect(ids(heads)).toEqual(["c", "r3", "r2", "r1"]);
    expect(readReflectionIndex(W).some((r) => r.id === "c")).toBe(false);
    listReflectionHeads(W);
    expect(readReflectionIndex(W).some((r) => r.id === "c")).toBe(true);
  });
});

describe("world names", () => {
  test("koleżka: NFD and NFC callers share one set of rows under the NFC key", () => {
    const nfc = "koleżka";
    const nfd = nfc.normalize("NFD");
    seedThree(nfc);
    expect(ids(listReflectionHeads(nfc))).toEqual(["r3", "r2", "r1"]);
    // The world filter is the file readers' raw equality, so an NFD caller
    // matches what listReflections(nfd) matches.
    expect(listReflectionHeads(nfd).map(pick)).toEqual(listReflections(nfd).map(pick));
    const rows = readReflectionIndex(nfc);
    expect(ids(rows).sort()).toEqual(["r1", "r2", "r3"]);
    expect(rows.every((r) => r.dirWorld === nfc)).toBe(true);
    expect(readReflectionIndex(nfd)).toEqual(rows);
  });

  test("a header without a world takes the caller's own spelling, as the file readers do", () => {
    const nfc = "koleżka";
    const nfd = nfc.normalize("NFD");
    const dir = paths.reflectionsDir(nfc);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "n.md"), raw("n"));
    for (const world of [nfc, nfd, nfc]) {
      expect(listReflectionHeads(world).map(pick)).toEqual(listReflections(world).map(pick));
      expect(ids(listReflectionHeads(world))).toEqual(["n"]);
    }
  });
});

describe("patternCounts and reflectedSessions", () => {
  test("patternCounts resolves aliases", () => {
    writeReflection(W, { id: "1" }, body("old"));
    writeReflection(W, { id: "2" }, body("new"));
    writeReflection(W, { id: "3" }, body("other"));
    saveAliases(W, { old: "new" });
    expect(patternCounts(W)).toEqual({ new: 2, other: 1 });
  });

  test("reflectedSessions keeps the newest mtime of one session's reflections", () => {
    const a = writeReflection(W, { id: "1", session_id: "s" }, body("p"));
    const b = writeReflection(W, { id: "2", session_id: "s" }, body("p"));
    utimesSync(a, new Date("2026-03-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));
    utimesSync(b, new Date("2026-04-01T00:00:00Z"), new Date("2026-04-01T00:00:00Z"));
    expect(reflectedSessions(W).get("s")).toBe(Date.parse("2026-04-01T00:00:00Z"));
  });
});

describe("a reused row is checked before it is trusted", () => {
  function replaceHead(head: string): void {
    closeState();
    const db = new Database(paths.loopStateDb());
    db.run("UPDATE reflection_index SET head = ?", [head]);
    db.close();
  }

  for (const [mode, read] of [
    ["strict", listReflectionHeadsStrict],
    ["tolerant", listReflectionHeads],
  ] as const) {
    test(`a malformed stored head is a stale row: ${mode} parses the file again and rewrites it`, () => {
      seedThree();
      expect(ids(read(W))).toEqual(["r3", "r2", "r1"]);
      replaceHead("{}");
      expect(read(W).map(pick)).toEqual((mode === "strict" ? listReflectionsStrict(W) : listReflections(W)).map(pick));
      expect(ids(read(W))).toEqual(["r3", "r2", "r1"]);
      for (const row of readReflectionIndex(W)) expect(JSON.parse(row.head).id).toBe(row.id);
    });
  }
});

describe("a reused row walked under another path", () => {
  test("a path-derived id follows a renamed symlink", () => {
    const dir = paths.reflectionsDir(W);
    const outside = join(tmp, "outside");
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "target.md"), "Pattern: p\n\nx\n");
    symlinkSync(join(outside, "target.md"), join(dir, "a.md"));
    expect(ids(listReflectionHeads(W))).toEqual(["a"]);
    renameSync(join(dir, "a.md"), join(dir, "b.md"));
    for (let pass = 0; pass < 2; pass++) {
      expect(listReflectionHeads(W).map(pick)).toEqual(listReflections(W).map(pick));
      expect(listReflectionHeadsStrict(W).map(pick)).toEqual(listReflectionsStrict(W).map(pick));
      expect(ids(listReflectionHeads(W))).toEqual(["b"]);
    }
  });

  test("the same file walked under another extra dir gets the full reader's id and path", () => {
    const first = join(tmp, "mirror-1");
    const second = join(tmp, "mirror-2");
    mkdirSync(first);
    mkdirSync(second);
    writeFileSync(join(first, "x.md"), "Pattern: p\n\nx\n");
    symlinkSync(join(first, "x.md"), join(second, "y.md"));
    expect(ids(listReflectionHeads(W, [first]))).toEqual(["x"]);
    for (let pass = 0; pass < 2; pass++) {
      expect(listReflectionHeads(W, [second]).map(pick)).toEqual(listReflections(W, [second]).map(pick));
      expect(listReflectionHeadsStrict(W, [second]).map(pick)).toEqual(listReflectionsStrict(W, [second]).map(pick));
      expect(listReflectionHeads(W, [second]).map((h) => [h.id, h.path])).toEqual([["y", join(second, "y.md")]]);
    }
  });
});
