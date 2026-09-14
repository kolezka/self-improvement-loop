import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, loadNudges } from "../src/dispatch.ts";
import { readFires } from "../src/firelog.ts";
import type { Nudge } from "../src/dispatch.ts";

let dir: string;
let sessionDir: string;
let fireLog: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sil-dispatch-"));
  sessionDir = join(dir, "session");
  mkdirSync(sessionDir, { recursive: true });
  fireLog = join(dir, "fires.jsonl");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function nudge(overrides: Partial<Nudge> = {}): Nudge {
  return {
    pattern: "commit-nudge",
    event: "PreToolUse",
    matcher: "Bash",
    gate: { command_matches: "git commit" },
    once_per: "session",
    text: "Write a good commit message.",
    ...overrides,
  };
}

describe("loadNudges", () => {
  test("reads json files from each dir in order, skipping invalid ones", () => {
    const nudgesDir = join(dir, "nudges");
    mkdirSync(nudgesDir, { recursive: true });
    writeFileSync(join(nudgesDir, "a.json"), JSON.stringify(nudge({ pattern: "a-nudge" })));
    writeFileSync(join(nudgesDir, "b-bad.json"), "not json");
    writeFileSync(join(nudgesDir, "c.json"), JSON.stringify(["not", "an", "object"]));
    const loaded = loadNudges([nudgesDir]);
    expect(loaded.length).toBe(1);
    expect(loaded[0]?.pattern).toBe("a-nudge");
  });

  test("a missing dir is skipped, not an error", () => {
    expect(loadNudges([join(dir, "does-not-exist")])).toEqual([]);
  });
});

describe("dispatch", () => {
  test("fires the first matching nudge and logs one fire", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };
    const text = dispatch(payload, [nudge()], { sessionDir, fireLog });
    expect(text).toBe("Write a good commit message.");
    const fires = readFires(fireLog);
    expect(fires.length).toBe(1);
    expect(fires[0]?.pattern).toBe("commit-nudge");
  });

  test("once_per session fires once per session, marker claimed only by the winner", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };
    const first = dispatch(payload, [nudge()], { sessionDir, fireLog });
    const second = dispatch(payload, [nudge()], { sessionDir, fireLog });
    expect(first).toBe("Write a good commit message.");
    expect(second).toBeNull();
    expect(readFires(fireLog).length).toBe(1);
  });

  test("a nudge that matches event/matcher but fails its gate never claims the marker", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } };
    const missed = dispatch(payload, [nudge()], { sessionDir, fireLog });
    expect(missed).toBeNull();
    // Now the command matches: the marker must still be free.
    const hitPayload = { ...payload, tool_input: { command: "git commit -m wip" } };
    const hit = dispatch(hitPayload, [nudge()], { sessionDir, fireLog });
    expect(hit).toBe("Write a good commit message.");
  });

  test("event mismatch never matches", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };
    expect(dispatch(payload, [nudge()], { sessionDir, fireLog })).toBeNull();
  });

  test("once_per always can fire repeatedly", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };
    const always = nudge({ once_per: "always" });
    expect(dispatch(payload, [always], { sessionDir, fireLog })).toBe("Write a good commit message.");
    expect(dispatch(payload, [always], { sessionDir, fireLog })).toBe("Write a good commit message.");
  });

  test("budget exhaustion writes a breadcrumb and stops scanning", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "irrelevant" } };
    // Every nudge matches event/matcher (so it reaches a gate) but never
    // matches the gate itself, forcing the whole list to be scanned.
    const many: Nudge[] = Array.from({ length: 5000 }, (_, i) => nudge({ pattern: `n-${i}`, gate: { command_matches: "will-not-match" } }));
    const result = dispatch(payload, many, { sessionDir, fireLog, budgetMs: 1 });
    expect(result).toBeNull();
    const fires = readFires(fireLog);
    expect(fires.some((f) => f.kind === "gate_budget_exhausted")).toBe(true);
  });

  test("never throws on a malformed nudge list", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse" };
    const broken = [null, 42, "nope"] as unknown as Nudge[];
    expect(() => dispatch(payload, broken, { sessionDir, fireLog })).not.toThrow();
  });
});
