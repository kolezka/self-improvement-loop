// The strict readers and their tolerant siblings side by side. Strict: absence
// is empty, anything else that stops the read raises. Tolerant: unchanged, for
// the learning and processing paths that rely on it. The reflection walk keeps
// its symlink and loop exclusions in both.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ConfigError, fsx, paths, readConfig, StateReadError } from "@sil/core";
import { closeState } from "@sil/statedb";
import {
  listLessons,
  listLessonsStrict,
  listReflections,
  listReflectionsStrict,
  loadAliases,
  loadAliasesStrict,
  loadLedger,
  putLesson,
  scanReflections,
  splitFrontMatter,
} from "../src/index.ts";

let tmp: string;
const saved: Record<string, string | undefined> = {};
const locked: string[] = [];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "sil-strict-readers-"));
  for (const k of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR"]) {
    saved[k] = process.env[k];
    process.env[k] = join(tmp, k.toLowerCase());
  }
});

afterEach(() => {
  closeState();
  for (const p of locked.splice(0)) chmodSync(p, 0o700);
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

const W = "w";

describe("lessons", () => {
  function seed(): string {
    putLesson({ id: "l1", world: W, pattern: "p", text: "t", created: "2026-10-22T10:00:00Z", reflection_id: null, repo: null, deliveries: 0 });
    return paths.inboxDir(W);
  }

  test("tolerant listLessons is unchanged: a bad lesson is skipped, an unlistable inbox is empty", () => {
    const dir = seed();
    writeFileSync(join(dir, "bad.json"), "{");
    expect(listLessons(W).map((l) => l.id)).toEqual(["l1"]);
    rmSync(dir, { recursive: true });
    writeFileSync(dir, "x");
    expect(listLessons(W)).toEqual([]);
  });

  test("strict: no inbox is empty, an unlistable one raises", () => {
    expect(listLessonsStrict(W)).toEqual([]);
    const dir = seed();
    expect(listLessonsStrict(W).map((l) => l.id)).toEqual(["l1"]);
    rmSync(dir, { recursive: true });
    writeFileSync(dir, "x");
    const err = thrown(() => listLessonsStrict(W));
    expect(err).toBeInstanceOf(StateReadError);
    expect(err!.message).toContain("ENOTDIR");
    expect(err!.message).not.toContain(tmp);
  });
});

describe("reflections", () => {
  const body = (id: string) => `---\nid: ${id}\ncreated: 2026-10-22\n---\nPattern: p\n\nx\n`;

  test("tolerant listReflections is unchanged: an unreadable file is skipped", () => {
    const dir = paths.reflectionsDir(W);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "a.md"), body("a"));
    writeFileSync(join(dir, "b.md"), body("b"));
    lock(join(dir, "b.md"));
    expect(listReflections(W).map((r) => r.id)).toEqual(["a"]);
    expect(scanReflections(W).unreadable).toEqual(["b.md"]);
    expect(() => listReflectionsStrict(W)).toThrow(StateReadError);
  });

  test("strict keeps the walk's exclusions: a looping dir link counts once, a link out is not followed", () => {
    const dir = paths.reflectionsDir(W);
    const outside = join(tmp, "outside");
    mkdirSync(join(dir, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(dir, "sub", "a.md"), body("a"));
    writeFileSync(join(outside, "x.md"), body("x"));
    symlinkSync("..", join(dir, "sub", "loop"));
    symlinkSync(outside, join(dir, "out"));
    const strict = listReflectionsStrict(W).map((r) => r.id);
    expect(strict).toEqual(["a"]);
    expect(listReflections(W).map((r) => r.id)).toEqual(strict);
  });

  test("strict: no reflections dir is empty", () => {
    expect(scanReflections(W)).toEqual({ reflections: [], unreadable: [] });
  });
});

describe("aliases", () => {
  test("tolerant loadAliases is unchanged; strict separates absence from a broken file", () => {
    expect(loadAliasesStrict(W)).toEqual({});
    const file = paths.aliasesFile(W);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, JSON.stringify({ old: "new" }));
    expect(loadAliasesStrict(W)).toEqual({ old: "new" });
    // The valid file was imported; a new one at the old path is a spill the
    // next read imports, and a broken one is quarantined. Tolerant keeps the
    // rows that imported (design D8), strict raises.
    writeFileSync(file, "{ broken");
    expect(loadAliases(W)).toEqual({ old: "new" });
    const err = thrown(() => loadAliasesStrict(W));
    expect(err).toBeInstanceOf(StateReadError);
    expect(err!.message).toContain("could not be imported");
    expect(err!.message).not.toContain(tmp);
  });
});

describe("readJsonlStrict", () => {
  const log = () => join(tmp, "log.jsonl");

  test("no file is empty; a valid last record without a newline is read like the tolerant reader reads it", () => {
    expect(fsx.readJsonlStrict(log(), "the log")).toEqual([]);
    writeFileSync(log(), JSON.stringify({ a: 1 }));
    expect(fsx.readJsonl(log())).toEqual([{ a: 1 }]);
    expect(fsx.readJsonlStrict(log(), "the log")).toEqual([{ a: 1 }]);
    writeFileSync(log(), `${JSON.stringify({ a: 1 })}\n${JSON.stringify({ a: 2 })}`);
    expect(fsx.readJsonlStrict(log(), "the log")).toEqual([{ a: 1 }, { a: 2 }]);
  });

  test("a malformed or unfinished tail raises: never a healthy shorter list", () => {
    writeFileSync(log(), "{broken");
    expect(() => fsx.readJsonlStrict(log(), "the log")).toThrow(/the log has 1 line that is not a JSON record/);
    writeFileSync(log(), `${JSON.stringify({ a: 1 })}\n{"a": 2`);
    expect(() => fsx.readJsonlStrict(log(), "the log")).toThrow(StateReadError);
    // The tolerant reader is unchanged: it still skips the bad tail.
    expect(fsx.readJsonl(log())).toEqual([{ a: 1 }]);
  });

  test("a bad finished line or an unreadable file raises; the tolerant reader still skips", () => {
    writeFileSync(log(), `${JSON.stringify({ a: 1 })}\nnot json\n${JSON.stringify({ a: 3 })}\n`);
    expect(fsx.readJsonl(log())).toEqual([{ a: 1 }, { a: 3 }]);
    expect(() => fsx.readJsonlStrict(log(), "the log")).toThrow(/the log has 1 line that is not a JSON record/);
    writeFileSync(log(), `${JSON.stringify({ a: 1 })}\n`);
    lock(log());
    const err = thrown(() => fsx.readJsonlStrict(log(), "the log"));
    expect(err).toBeInstanceOf(StateReadError);
    expect(err!.message).toBe("the log cannot be read (EACCES)");
  });
});

describe("ledger and config", () => {
  test("loadLedger: no file is empty, an unreachable one raises for every caller", () => {
    const dir = join(tmp, "target", "meta");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "promotions.json");
    expect(loadLedger(path).entries).toEqual({});
    writeFileSync(path, JSON.stringify({ version: 1, entries: {} }));
    lock(dir);
    const err = thrown(() => loadLedger(path));
    expect(err).toBeInstanceOf(StateReadError);
    expect(err!.message).toBe("the ledger promotions.json cannot be read (EACCES)");
  });

  test("readConfig: no file is not present; an unreachable one raises ConfigError", () => {
    const dir = join(tmp, "cfg");
    mkdirSync(dir);
    const path = join(dir, "config.yaml");
    expect(readConfig(path).present).toBe(false);
    writeFileSync(path, "version: 1\nworlds:\n  - name: w\n");
    expect(readConfig(path)).toMatchObject({ present: true });
    lock(dir);
    const err = thrown(() => readConfig(path));
    expect(err).toBeInstanceOf(ConfigError);
    expect(err!.message).toBe("config.yaml cannot be read (EACCES)");
  });
});

// The tolerant splitter is the learning paths' and must not move with the
// strict header states: each input reads exactly as the baseline read it.
describe("tolerant splitFrontMatter is unchanged across header states", () => {
  test.each([
    ["no header", "Pattern: p\n", [{}, "Pattern: p\n"]],
    ["closed header", "---\nid: a\n---\nPattern: p\n", [{ id: "a" }, "Pattern: p\n"]],
    ["unclosed header", "---\nid: a\nPattern: p\n", [{}, "---\nid: a\nPattern: p\n"]],
    ["empty header, no later ruler", "---\n---\nPattern: p\n", [{}, "---\n---\nPattern: p\n"]],
    // Measured on the baseline function (git f194f06): it reads "---\nPattern: p" as the header.
    ["empty header, a later ruler", "---\n---\nPattern: p\n---\nmore\n", [{ Pattern: "p" }, "more\n"]],
    ["closed header that is not YAML", "---\nid: [x\n---\nPattern: p\n", [{}, "Pattern: p\n"]],
  ])("%s", (_name, text, expected) => {
    expect(splitFrontMatter(text as string)).toEqual(expected as [Record<string, unknown>, string]);
  });

  test("tolerant listReflections still reads an unclosed header as no header", () => {
    const dir = paths.reflectionsDir(W);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "u.md"), "---\nworld: other\nPattern: p\n");
    expect(listReflections(W).map((r) => r.id)).toEqual(["u"]);
    expect(() => listReflectionsStrict(W)).toThrow(/cannot be read or parsed: u\.md/);
  });
});
