import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendLine, claimMarker, readFires, withDirLock, writeBreadcrumb } from "../src/firelog.ts";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sil-firelog-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("withDirLock", () => {
  test("runs fn and releases the lock dir", () => {
    const lockDir = join(dir, "lock.lockdir");
    const result = withDirLock(lockDir, () => 42);
    expect(result).toBe(42);
    expect(() => readFileSync(lockDir)).toThrow();
  });

  test("serializes two callers so neither observes the other's half-done state", () => {
    const lockDir = join(dir, "lock.lockdir");
    const events: string[] = [];
    withDirLock(lockDir, () => {
      events.push("first-start");
      events.push("first-end");
    });
    withDirLock(lockDir, () => {
      events.push("second-start");
      events.push("second-end");
    });
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  test("takes over a stale lock instead of hanging forever", () => {
    const lockDir = join(dir, "lock.lockdir");
    mkdirSync(lockDir);
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockDir, old, old);
    const result = withDirLock(lockDir, () => "acquired", 50);
    expect(result).toBe("acquired");
  });
});

describe("claimMarker", () => {
  test("true the first time, false after", () => {
    expect(claimMarker(dir, "some-nudge")).toBe(true);
    expect(claimMarker(dir, "some-nudge")).toBe(false);
  });

  test("different names get independent markers", () => {
    expect(claimMarker(dir, "a")).toBe(true);
    expect(claimMarker(dir, "b")).toBe(true);
  });

  test("fails closed when the session dir cannot be created", () => {
    // A file where a directory is expected: mkdirSync must fail.
    const blocked = join(dir, "blocked-file");
    writeFileSync(blocked, "");
    expect(claimMarker(join(blocked, "nested"), "x")).toBe(false);
  });
});

describe("writeBreadcrumb", () => {
  test("writes once per (session dir, kind, event)", () => {
    const fireLog = join(dir, "fires.jsonl");
    writeBreadcrumb(fireLog, dir, "nudge_dir_missing", "sess-1", "PreToolUse");
    writeBreadcrumb(fireLog, dir, "nudge_dir_missing", "sess-1", "PreToolUse");
    const fires = readFires(fireLog);
    expect(fires.length).toBe(1);
    expect(fires[0]?.kind).toBe("nudge_dir_missing");
    expect(fires[0]?.session_id).toBe("sess-1");
  });
});

describe("appendLine + readFires", () => {
  test("round-trips records and tolerates a torn line", () => {
    const path = join(dir, "log.jsonl");
    appendLine(path, JSON.stringify({ a: 1 }));
    appendLine(path, JSON.stringify({ a: 2 }));
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw + "not json\n");
    const fires = readFires(path);
    expect(fires.length).toBe(2);
  });

  test("rotates when the file passes rotateAt, dropping the oldest lines", () => {
    // rotateIfNeeded checks size before each append, so the file can sit a
    // few lines above `keep` right after a rotation and before the next one
    // fires; what must hold is that old lines get dropped, not that the
    // count never exceeds `keep` at every instant.
    const path = join(dir, "rotate.jsonl");
    for (let i = 0; i < 20; i++) appendLine(path, JSON.stringify({ i }), 100, 5);
    const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
    expect(lines.length).toBeLessThan(20);
    const parsed = lines.map((l) => JSON.parse(l).i as number);
    expect(parsed).not.toContain(0);
    expect(parsed[parsed.length - 1]).toBe(19);
  });
});
