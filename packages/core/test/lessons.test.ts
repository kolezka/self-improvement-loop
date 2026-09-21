import { describe, expect, test } from "bun:test";
import { LESSON_ARCHIVE_AT_DELIVERIES, formatLesson, rulesBlockFrom, selectLessons } from "../src/lessons.ts";
import type { LessonCandidate } from "../src/lessons.ts";
import { RULE_END, RULE_START } from "../src/consts.ts";

function candidate(id: string, fields: Record<string, unknown> = {}, mtimeMs = 0): LessonCandidate {
  return { path: `/inbox/${id}.json`, stem: id, mtimeMs, raw: { id, created: "2026-01-01T00:00:00.000Z", ...fields } };
}

const ALWAYS_UNDER = (): boolean => true;
const NEVER_UNDER = (): boolean => false;

describe("selectLessons", () => {
  test("newest created first", () => {
    const candidates = [
      candidate("old", { created: "2020-01-01T00:00:00.000Z" }),
      candidate("newest", { created: "2026-06-01T00:00:00.000Z" }),
      candidate("middle", { created: "2024-01-01T00:00:00.000Z" }),
    ];
    const chosen = selectLessons(candidates, new Set(), ALWAYS_UNDER, 10, null);
    expect(chosen.map((c) => c.obj["id"])).toEqual(["newest", "middle", "old"]);
  });

  test("a missing created sorts last, not as the string 'undefined'", () => {
    const candidates = [candidate("no-date", { created: undefined }), candidate("dated", { created: "2020-01-01T00:00:00.000Z" })];
    const chosen = selectLessons(candidates, new Set(), ALWAYS_UNDER, 10, null);
    expect(chosen.map((c) => c.obj["id"])).toEqual(["dated", "no-date"]);
  });

  test("limit caps the result after sorting", () => {
    const candidates = [
      candidate("old", { created: "2020-01-01T00:00:00.000Z" }),
      candidate("newest", { created: "2026-06-01T00:00:00.000Z" }),
    ];
    expect(selectLessons(candidates, new Set(), ALWAYS_UNDER, 1, null).map((c) => c.obj["id"])).toEqual(["newest"]);
    expect(selectLessons(candidates, new Set(), ALWAYS_UNDER, 0, null)).toEqual([]);
  });

  test("a delivered file stem is skipped without reading its id", () => {
    const stale: LessonCandidate = { path: "/inbox/done.json", stem: "done", mtimeMs: 0, raw: { id: "different-id" } };
    expect(selectLessons([stale], new Set(["done"]), ALWAYS_UNDER, 10, null)).toEqual([]);
  });

  test("a delivered id is skipped even when the file stem differs", () => {
    const renamed: LessonCandidate = { path: "/inbox/01-renamed.json", stem: "01-renamed", mtimeMs: 0, raw: { id: "lesson-a" } };
    expect(selectLessons([renamed], new Set(["lesson-a"]), ALWAYS_UNDER, 10, null)).toEqual([]);
  });

  test("minMtime null keeps everything, a set minMtime drops what predates it", () => {
    const candidates = [candidate("older", {}, 100), candidate("newer", {}, 300)];
    expect(selectLessons(candidates, new Set(), ALWAYS_UNDER, 10, null).length).toBe(2);
    expect(selectLessons(candidates, new Set(), ALWAYS_UNDER, 10, 200).map((c) => c.obj["id"])).toEqual(["newer"]);
    // At the cutoff exactly, not before it: the boundary counts as arrived.
    expect(selectLessons(candidates, new Set(), ALWAYS_UNDER, 10, 300).map((c) => c.obj["id"])).toEqual(["newer"]);
  });

  test("a repo-scoped lesson is dropped when the cwd is not under that repo", () => {
    const scoped = [candidate("scoped", { repo: "/some/repo" })];
    expect(selectLessons(scoped, new Set(), NEVER_UNDER, 10, null)).toEqual([]);
    expect(selectLessons(scoped, new Set(), ALWAYS_UNDER, 10, null).length).toBe(1);
  });

  test("an empty or non-string repo is not a filter", () => {
    const candidates = [candidate("blank-repo", { repo: "" }), candidate("number-repo", { repo: 7 })];
    expect(selectLessons(candidates, new Set(), NEVER_UNDER, 10, null).length).toBe(2);
  });

  test("unparseable or non-object raw is skipped", () => {
    const junk: LessonCandidate[] = [
      { path: "/inbox/a.json", stem: "a", mtimeMs: 0, raw: undefined },
      { path: "/inbox/b.json", stem: "b", mtimeMs: 0, raw: null },
      { path: "/inbox/c.json", stem: "c", mtimeMs: 0, raw: ["not", "an", "object"] },
      { path: "/inbox/d.json", stem: "d", mtimeMs: 0, raw: "a string" },
    ];
    expect(selectLessons(junk, new Set(), ALWAYS_UNDER, 10, null)).toEqual([]);
  });

  test("a non-string id is stringified, a missing or empty one is skipped", () => {
    const candidates: LessonCandidate[] = [
      { path: "/inbox/num.json", stem: "num", mtimeMs: 0, raw: { id: 42 } },
      { path: "/inbox/none.json", stem: "none", mtimeMs: 0, raw: { pattern: "no id here" } },
      { path: "/inbox/empty.json", stem: "empty", mtimeMs: 0, raw: { id: "" } },
      { path: "/inbox/nul.json", stem: "nul", mtimeMs: 0, raw: { id: null } },
    ];
    const chosen = selectLessons(candidates, new Set(), ALWAYS_UNDER, 10, null);
    expect(chosen.map((c) => c.path)).toEqual(["/inbox/num.json"]);
    // And a stringified id is what the delivered set is then matched on.
    expect(selectLessons(candidates, new Set(["42"]), ALWAYS_UNDER, 10, null)).toEqual([]);
  });

  test("the returned path is the candidate's, so the caller can bump the right file", () => {
    const chosen = selectLessons([candidate("x")], new Set(), ALWAYS_UNDER, 10, null);
    expect(chosen[0]?.path).toBe("/inbox/x.json");
  });
});

describe("formatLesson", () => {
  test("pattern and text, blank when either is missing", () => {
    expect(formatLesson({ id: "a", pattern: "p", text: "t" })).toBe("Lesson (p): t");
    expect(formatLesson({ id: "a" })).toBe("Lesson (): ");
  });
});

describe("rulesBlockFrom", () => {
  test("the trimmed text between the markers", () => {
    expect(rulesBlockFrom(`before\n${RULE_START}\nthe rule\n${RULE_END}\nafter`)).toBe("the rule");
  });

  test("empty when a marker is missing or the end precedes the start", () => {
    expect(rulesBlockFrom(`${RULE_START}\nonly a start\n`)).toBe("");
    expect(rulesBlockFrom(`${RULE_END}\nonly an end\n`)).toBe("");
    expect(rulesBlockFrom("no markers at all")).toBe("");
    expect(rulesBlockFrom(`${RULE_END}\ninverted\n${RULE_START}`)).toBe("");
  });
});

describe("LESSON_ARCHIVE_AT_DELIVERIES", () => {
  test("is the threshold apps/hook archives at", () => {
    expect(LESSON_ARCHIVE_AT_DELIVERIES).toBe(5);
  });
});
