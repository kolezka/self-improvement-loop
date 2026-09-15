import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import * as paths from "@sil/core/paths";
import { bumpLessonDeliveries, pendingLessons, rulesBlock } from "../src/lessons.ts";
import { cleanupHookEnv, makeHookEnv } from "./helpers.ts";
import type { HookEnv } from "./helpers.ts";

let hookEnv: HookEnv;
const ORIGINAL_ENV: Record<string, string | undefined> = {};

beforeEach(() => {
  hookEnv = makeHookEnv();
  for (const key of ["SIL_CONFIG_DIR", "SIL_STATE_DIR", "SIL_DATA_DIR", "CLAUDE_PLUGIN_ROOT"]) {
    ORIGINAL_ENV[key] = process.env[key];
    process.env[key] = hookEnv.env[key];
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  cleanupHookEnv(hookEnv);
});

function writeLesson(worldName: string, id: string, fields: Record<string, unknown> = {}): string {
  const dir = paths.inboxDir(worldName);
  mkdirSync(dir, { recursive: true });
  const path = `${dir}/${id}.json`;
  writeFileSync(path, JSON.stringify({ id, pattern: "some-pattern", text: "some lesson text", created: "2026-01-01T00:00:00.000Z", ...fields }));
  return path;
}

describe("pendingLessons", () => {
  test("delivers a new lesson and marks it delivered", () => {
    writeLesson("default", "lesson-1");
    const first = pendingLessons("default", "sess-1", "/tmp", 3);
    expect(first.length).toBe(1);
    expect(first[0]?.id).toBe("lesson-1");

    const second = pendingLessons("default", "sess-1", "/tmp", 3);
    expect(second.length).toBe(0);
  });

  test("filters candidates by repo before it ever parses their JSON", () => {
    writeLesson("default", "already-delivered");
    // Pre-mark it delivered directly, mirroring what a prior session start did.
    mkdirSync(paths.sessionDir("sess-2"), { recursive: true });
    writeFileSync(`${paths.sessionDir("sess-2")}/delivered`, "already-delivered\n");
    writeLesson("default", "new-one");

    const before = readdirSync(paths.inboxDir("default")).length;
    const chosen = pendingLessons("default", "sess-2", "/tmp", 3);
    expect(before).toBe(2);
    expect(chosen.length).toBe(1);
    expect(chosen[0]?.id).toBe("new-one");
  });

  test("skips a lesson scoped to a repo the cwd is not under", () => {
    writeLesson("default", "scoped", { repo: "/some/other/repo" });
    const chosen = pendingLessons("default", "sess-3", "/tmp/unrelated", 3);
    expect(chosen.length).toBe(0);
  });

  test("newest (by created) first, capped at limit", () => {
    writeLesson("default", "old", { created: "2020-01-01T00:00:00.000Z" });
    writeLesson("default", "newer", { created: "2025-01-01T00:00:00.000Z" });
    const chosen = pendingLessons("default", "sess-4", "/tmp", 1);
    expect(chosen.length).toBe(1);
    expect(chosen[0]?.id).toBe("newer");
  });

  test("sinceSessionStart filters out lessons that predate start.json's mtime", () => {
    const oldPath = writeLesson("default", "old-lesson");
    const old = new Date(Date.now() - 60_000);
    utimesSync(oldPath, old, old);

    mkdirSync(paths.sessionDir("sess-5"), { recursive: true });
    writeFileSync(`${paths.sessionDir("sess-5")}/start.json`, JSON.stringify({ ts: new Date().toISOString() }));

    writeLesson("default", "new-lesson");

    const chosen = pendingLessons("default", "sess-5", "/tmp", 3, true);
    expect(chosen.length).toBe(1);
    expect(chosen[0]?.id).toBe("new-lesson");
  });
});

describe("bumpLessonDeliveries", () => {
  test("increments deliveries and archives at the threshold", () => {
    const path = writeLesson("default", "almost-done", { deliveries: 4 });
    bumpLessonDeliveries("default", path, { id: "almost-done", deliveries: 4 });

    const archived = `${paths.inboxDir("default")}/archive/almost-done.json`;
    const parsed = JSON.parse(readFileSync(archived, "utf8"));
    expect(parsed.deliveries).toBe(5);
  });

  test("stays in the inbox below the threshold", () => {
    const path = writeLesson("default", "still-active", { deliveries: 1 });
    bumpLessonDeliveries("default", path, { id: "still-active", deliveries: 1 });
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.deliveries).toBe(2);
  });
});

describe("rulesBlock", () => {
  test("extracts the text between RULE_START and RULE_END", () => {
    const rulesFile = `${hookEnv.root}/RULES.md`;
    writeFileSync(rulesFile, "before\n<!--loop-rules:start-->\nthe rule text\n<!--loop-rules:end-->\nafter\n");
    expect(rulesBlock({ rules_inject: true, rules_file: rulesFile })).toBe("the rule text");
  });

  test("empty when rules_inject is false", () => {
    expect(rulesBlock({ rules_inject: false, rules_file: `${hookEnv.root}/RULES.md` })).toBe("");
  });

  test("empty when the file is missing", () => {
    expect(rulesBlock({ rules_inject: true, rules_file: `${hookEnv.root}/does-not-exist.md` })).toBe("");
  });
});

describe("pendingLessons since session start", () => {
  test("falls back to the session dir mtime when start.json is missing", () => {
    const oldPath = writeLesson("default", "predates-session");
    const old = new Date(Date.now() - 60_000);
    utimesSync(oldPath, old, old);

    // A session dir but no start.json: the SessionStart write failed.
    mkdirSync(paths.sessionDir("sess-no-start-json"), { recursive: true });
    writeLesson("default", "arrived-after");

    const chosen = pendingLessons("default", "sess-no-start-json", "/tmp", 3, true);
    expect(chosen.map((l) => l.id)).toEqual(["arrived-after"]);
  });

  test("delivers nothing when there is no session dir to date from", () => {
    // No cutoff at all used to mean no filter, so UserPromptSubmit flooded
    // the prompt with the whole inbox backlog.
    writeLesson("default", "backlog-1");
    writeLesson("default", "backlog-2");
    expect(pendingLessons("default", "sess-never-started", "/tmp", 3, true)).toEqual([]);
  });

  test("SessionStart still delivers the backlog without the flag", () => {
    writeLesson("default", "backlog-3");
    expect(pendingLessons("default", "sess-session-start", "/tmp", 3).length).toBe(1);
  });
});

describe("rulesBlock bounds what it reads", () => {
  test("a rules file over the size cap yields nothing", () => {
    const rulesFile = `${hookEnv.root}/BIG-RULES.md`;
    const filler = "x".repeat(1024 * 1024);
    writeFileSync(rulesFile, `<!--loop-rules:start-->\nthe rule text\n<!--loop-rules:end-->\n${filler}`);
    expect(rulesBlock({ rules_inject: true, rules_file: rulesFile })).toBe("");
  });

  test("a file just under the cap still works", () => {
    const rulesFile = `${hookEnv.root}/OK-RULES.md`;
    writeFileSync(rulesFile, `<!--loop-rules:start-->\nthe rule text\n<!--loop-rules:end-->\n${"x".repeat(1000)}`);
    expect(rulesBlock({ rules_inject: true, rules_file: rulesFile })).toBe("the rule text");
  });

  test("a path that is not a regular file is skipped, not read", () => {
    // A fifo blocks in open() forever, the same way /dev/zero reads forever:
    // the snapshot supplies this path, so it can name either.
    const fifo = `${hookEnv.root}/rules.fifo`;
    const made = Bun.spawnSync(["mkfifo", fifo]);
    expect(made.exitCode).toBe(0);

    const started = Date.now();
    expect(rulesBlock({ rules_inject: true, rules_file: fifo })).toBe("");
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
