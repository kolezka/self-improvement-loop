// Unit tests for the Logs pane parsing helpers.

import { describe, expect, test } from "bun:test";
import { highlight, levelOf, matchesFilter, parseLogLine, parseLogLines, sizeText } from "../src/lib/logs.ts";

describe("parseLogLine", () => {
  test("flattens a worker JSON record and keeps ts out of the text", () => {
    const raw = JSON.stringify({ ts: "2026-09-18T10:00:00.000Z", action: "reflect", session_id: "abc", result: "done" });
    const line = parseLogLine(raw, 1);
    expect(line.text).toBe("action=reflect session_id=abc result=done");
    expect(line.iso).toBe("2026-09-18T10:00:00.000Z");
    expect(line.time).not.toBe("");
    expect(line.level).toBe("info");
  });

  test("splits an iso prefixed plain line into time and message", () => {
    const line = parseLogLine("2026-09-18T10:00:00.000Z SessionStart could not write start.json: EACCES", 2);
    expect(line.iso).toBe("2026-09-18T10:00:00.000Z");
    expect(line.text).toBe("SessionStart could not write start.json: EACCES");
    expect(line.index).toBe(2);
  });

  test("keeps a line without a timestamp whole and leaves the time column empty", () => {
    const line = parseLogLine("plain stdout from the curriculum run", 3);
    expect(line.time).toBe("");
    expect(line.iso).toBe("");
    expect(line.text).toBe("plain stdout from the curriculum run");
  });

  test("treats a broken JSON line as plain text instead of dropping it", () => {
    const line = parseLogLine('{"ts": "2026-09-18T10:00:00Z", "action": ', 4);
    expect(line.text).toContain('{"ts"');
    expect(line.time).toBe("");
  });

  test("ignores a JSON array line and shows it raw", () => {
    const line = parseLogLine('[1, 2, 3]', 5);
    expect(line.text).toBe("[1, 2, 3]");
  });

  test("renders a non-string JSON value as JSON, not [object Object]", () => {
    const raw = JSON.stringify({ ts: "2026-09-18T10:00:00Z", action: "run", summary: { queued: 2 } });
    expect(parseLogLine(raw, 1).text).toBe('action=run summary={"queued":2}');
  });

  test("leaves the time empty when ts is not a parseable date", () => {
    const raw = JSON.stringify({ ts: "not a date", action: "reflect" });
    const line = parseLogLine(raw, 1);
    expect(line.iso).toBe("not a date");
    expect(line.time).toBe("");
  });

  test("numbers lines from one", () => {
    const lines = parseLogLines(["a", "b"]);
    expect(lines.map((l) => l.index)).toEqual([1, 2]);
  });
});

describe("levelOf", () => {
  test("marks failures as error", () => {
    expect(levelOf("action=feedback result=failed: connection refused")).toBe("error");
  });

  test("marks a retry as warn", () => {
    expect(levelOf("action=reflect result=retry later (1/3): rate limit")).toBe("warn");
  });

  test("does not fire on a word that only contains a level word inside an identifier", () => {
    expect(levelOf("action=reap_stale_sessions result=removed 2")).toBe("info");
  });

  test("marks the hook's could-not wording as error", () => {
    expect(levelOf("SessionStart could not write start.json: EACCES")).toBe("error");
  });

  test("marks a slow hook invocation as warn", () => {
    expect(levelOf("slow hook invocation: event=Stop elapsed_ms=210.4")).toBe("warn");
  });

  test("marks a session the hook did not queue as warn, not error", () => {
    expect(levelOf("Stop not queued for abc: transcript not on disk")).toBe("warn");
  });

  test("leaves a zero counter alone instead of painting the line red", () => {
    expect(levelOf("action=stats errors=0 warnings=0")).toBe("info");
    expect(levelOf("action=poll skipped=0 retries=0")).toBe("info");
  });

  test("still reports a non-zero failure counter", () => {
    expect(levelOf("action=stats failures=3")).toBe("error");
  });

  test("defaults to info", () => {
    expect(levelOf("action=reflect result=done")).toBe("info");
  });
});

describe("matchesFilter", () => {
  const line = parseLogLine("2026-09-18T10:00:00Z Session queued for abc", 1);

  test("matches case insensitively", () => {
    expect(matchesFilter(line, "SESSION")).toBe(true);
  });

  test("matches the timestamp behind the time column", () => {
    expect(matchesFilter(line, "2026-09-18")).toBe(true);
  });

  // The filter has to match what the console shows. A worker record renders as
  // key=value, so matching its raw JSON would hide lines the user can read.
  test("matches a worker record by its displayed key=value text", () => {
    const raw = JSON.stringify({ ts: "2026-09-18T10:00:00Z", action: "reflect", session_id: "abc" });
    expect(matchesFilter(parseLogLine(raw, 1), "action=reflect")).toBe(true);
  });

  test("keeps every line when the query is blank", () => {
    expect(matchesFilter(line, "   ")).toBe(true);
  });

  test("rejects a miss", () => {
    expect(matchesFilter(line, "curriculum")).toBe(false);
  });
});

describe("highlight", () => {
  test("returns one plain segment for a blank query", () => {
    expect(highlight("abc", "")).toEqual([{ text: "abc", hit: false }]);
  });

  test("marks every occurrence and keeps the original casing", () => {
    expect(highlight("Reflect and reflect", "reflect")).toEqual([
      { text: "Reflect", hit: true },
      { text: " and ", hit: false },
      { text: "reflect", hit: true },
    ]);
  });

  test("keeps the tail after the last hit", () => {
    expect(highlight("done: ok", "done")).toEqual([
      { text: "done", hit: true },
      { text: ": ok", hit: false },
    ]);
  });

  test("rejoins to the input text", () => {
    const text = "action=reflect result=done";
    expect(highlight(text, "e").map((s) => s.text).join("")).toBe(text);
  });

  test("treats regex metacharacters in the query as literal text", () => {
    expect(highlight("result=retry later (1/3)", "(1/3)")).toEqual([
      { text: "result=retry later ", hit: false },
      { text: "(1/3)", hit: true },
    ]);
    expect(highlight("a.b", ".")).toEqual([
      { text: "a", hit: false },
      { text: ".", hit: true },
      { text: "b", hit: false },
    ]);
  });

  // A lowercased copy shifts offsets whenever a character folds to two, which
  // slices the mark off the word it belongs to.
  test("keeps the mark on the match when case folding changes length", () => {
    expect(highlight("\u0130STANBUL error", "error")).toEqual([
      { text: "\u0130STANBUL ", hit: false },
      { text: "error", hit: true },
    ]);
  });

  test("gives up on a line with more hits than the cap instead of building thousands of nodes", () => {
    const text = "e".repeat(200);
    expect(highlight(text, "e")).toEqual([{ text, hit: false }]);
  });

  test("leaves a very long line unmarked", () => {
    const text = "x".repeat(5000);
    expect(highlight(text, "x")).toEqual([{ text, hit: false }]);
  });
});

describe("sizeText", () => {
  test("uses bytes below a kilobyte", () => {
    expect(sizeText(512)).toBe("512 bytes");
  });

  test("uses KB below a megabyte", () => {
    expect(sizeText(2048)).toBe("2.0 KB");
  });

  test("uses MB from a megabyte up", () => {
    expect(sizeText(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
