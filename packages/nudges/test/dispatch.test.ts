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

describe("loadNudges lints before it loads", () => {
  function writeNudge(nudgesDir: string, name: string, body: unknown): void {
    mkdirSync(nudgesDir, { recursive: true });
    writeFileSync(join(nudgesDir, name), JSON.stringify(body));
  }

  test("a hand-placed nudge with a catastrophic gate never reaches dispatch", () => {
    // Nothing can interrupt this regex once evaluate() starts it, so the
    // only place to stop it is here, at load.
    const nudgesDir = join(dir, "nudges");
    writeNudge(nudgesDir, "a-ok.json", nudge({ pattern: "a-ok" }));
    writeNudge(nudgesDir, "b-evil.json", nudge({ pattern: "b-evil", gate: { command_matches: "(i|ii)+" } }));

    const loaded = loadNudges([nudgesDir]);
    expect(loaded.map((n) => n.pattern)).toEqual(["a-ok"]);
  });

  test("other lint failures are dropped too: bad slug, unknown event, oversized text", () => {
    const nudgesDir = join(dir, "nudges");
    writeNudge(nudgesDir, "a-slug.json", nudge({ pattern: "Not A Slug" }));
    writeNudge(nudgesDir, "b-event.json", nudge({ event: "NotAnEvent" }));
    writeNudge(nudgesDir, "c-text.json", nudge({ text: "x".repeat(401) }));
    writeNudge(nudgesDir, "d-gate.json", nudge({ gate: { unknown_predicate: true } }));
    writeNudge(nudgesDir, "e-fine.json", nudge({ pattern: "e-fine" }));

    expect(loadNudges([nudgesDir]).map((n) => n.pattern)).toEqual(["e-fine"]);
  });

  test("loadNudgesDetailed names every rejected file and why", async () => {
    const { loadNudgesDetailed } = await import("../src/dispatch.ts");
    const nudgesDir = join(dir, "nudges");
    writeNudge(nudgesDir, "a-ok.json", nudge({ pattern: "a-ok" }));
    writeNudge(nudgesDir, "b-evil.json", nudge({ pattern: "b-evil", gate: { command_matches: "(i|ii)+" } }));
    writeFileSync(join(nudgesDir, "c-torn.json"), "{not json");

    const { nudges, rejected } = loadNudgesDetailed([nudgesDir]);
    expect(nudges.map((n) => n.pattern)).toEqual(["a-ok"]);
    expect(rejected.map((r) => r.file)).toEqual([join(nudgesDir, "b-evil.json"), join(nudgesDir, "c-torn.json")]);
    expect(rejected[0]?.problems.some((p) => p.includes("backtrack catastrophically"))).toBe(true);
  });

  test("the nudges this repo ships are all lint clean", async () => {
    // Guards the fix from the other side: a lint that rejected a builtin
    // would silently disable it in every session.
    const { loadNudgesDetailed } = await import("../src/dispatch.ts");
    const builtin = new URL("../../../nudges", import.meta.url).pathname;
    const { nudges, rejected } = loadNudgesDetailed([builtin]);
    expect(rejected).toEqual([]);
    expect(nudges.length).toBeGreaterThan(0);
  });
});

describe("gate_overrun", () => {
  test("a gate that runs past gateTimeoutMs logs one breadcrumb", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "x".repeat(4000) } };
    dispatch(payload, [nudge({ gate: { command_matches: "will-not-match" } })], { sessionDir, fireLog, gateTimeoutMs: 0 });
    const fires = readFires(fireLog);
    const overrun = fires.filter((f) => f.kind === "gate_overrun");
    expect(overrun.length).toBe(1);
    expect(overrun[0]?.pattern).toBe("commit-nudge");
  });

  test("a normal gate under the default timeout logs nothing", () => {
    const payload = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git status" } };
    dispatch(payload, [nudge()], { sessionDir, fireLog });
    expect(readFires(fireLog).some((f) => f.kind === "gate_overrun")).toBe(false);
  });
});
