import { describe, expect, test } from "bun:test";
import { dispatchWith, lintLoadedNudges } from "../src/dispatch-core.ts";
import type { DispatchSink, Nudge } from "../src/dispatch-core.ts";

interface Recorder extends DispatchSink {
  claimed: string[];
  fires: Array<Record<string, unknown>>;
  breadcrumbs: Array<Record<string, unknown>>;
}

/** In-memory stand-in for the firelog sink, with the same fail-closed
 * once-per-session marker semantics. */
function recorder(): Recorder {
  const taken = new Set<string>();
  const claimed: string[] = [];
  const fires: Array<Record<string, unknown>> = [];
  const breadcrumbs: Array<Record<string, unknown>> = [];
  return {
    claimed,
    fires,
    breadcrumbs,
    claimMarker(name) {
      claimed.push(name);
      if (taken.has(name)) return false;
      taken.add(name);
      return true;
    },
    fire(record) {
      fires.push(record as unknown as Record<string, unknown>);
    },
    breadcrumb(record) {
      breadcrumbs.push(record as unknown as Record<string, unknown>);
    },
  };
}

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

const HIT = { session_id: "sess-1", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit -m wip" } };

describe("dispatchWith", () => {
  test("fires once per session through the sink", () => {
    const sink = recorder();
    expect(dispatchWith(HIT, [nudge()], sink)).toBe("Write a good commit message.");
    expect(dispatchWith(HIT, [nudge()], sink)).toBeNull();
    expect(sink.fires.length).toBe(1);
    expect(sink.fires[0]).toEqual({
      ts: sink.fires[0]?.["ts"] as string,
      pattern: "commit-nudge",
      session_id: "sess-1",
      event: "PreToolUse",
    });
    expect(sink.claimed).toEqual(["nudge-commit-nudge", "nudge-commit-nudge"]);
  });

  test("the fire record keys are ts, pattern, session_id, event in that order", () => {
    const sink = recorder();
    dispatchWith(HIT, [nudge()], sink);
    expect(Object.keys(sink.fires[0] ?? {})).toEqual(["ts", "pattern", "session_id", "event"]);
  });

  test('once_per "always" never touches the marker', () => {
    const sink = recorder();
    const always = nudge({ once_per: "always" });
    expect(dispatchWith(HIT, [always], sink)).toBe("Write a good commit message.");
    expect(dispatchWith(HIT, [always], sink)).toBe("Write a good commit message.");
    expect(sink.claimed).toEqual([]);
    expect(sink.fires.length).toBe(2);
  });

  test("an unrecognised once_per fails closed to session scope", () => {
    const sink = recorder();
    const odd = nudge({ once_per: "hourly" as unknown as Nudge["once_per"] });
    expect(dispatchWith(HIT, [odd], sink)).toBe("Write a good commit message.");
    expect(dispatchWith(HIT, [odd], sink)).toBeNull();
  });

  test("a sink that refuses the marker suppresses the fire", () => {
    const sink = recorder();
    sink.claimMarker = (): boolean => false;
    expect(dispatchWith(HIT, [nudge()], sink)).toBeNull();
    expect(sink.fires).toEqual([]);
  });

  test("a nudge that loses to an earlier one keeps its marker", () => {
    const sink = recorder();
    const winner = nudge({ pattern: "winner" });
    const loser = nudge({ pattern: "loser" });
    expect(dispatchWith(HIT, [winner, loser], sink)).toBe("Write a good commit message.");
    expect(sink.claimed).toEqual(["nudge-winner"]);
  });

  test("a gate miss never claims the marker", () => {
    const sink = recorder();
    const miss = { ...HIT, tool_input: { command: "git status" } };
    expect(dispatchWith(miss, [nudge()], sink)).toBeNull();
    expect(sink.claimed).toEqual([]);
    expect(dispatchWith(HIT, [nudge()], sink)).toBe("Write a good commit message.");
  });

  test("event and matcher mismatches never reach the gate", () => {
    const sink = recorder();
    expect(dispatchWith({ ...HIT, hook_event_name: "PostToolUse" }, [nudge()], sink)).toBeNull();
    expect(dispatchWith({ ...HIT, tool_name: "Read" }, [nudge()], sink)).toBeNull();
    expect(sink.claimed).toEqual([]);
  });

  test("budget exhaustion writes one breadcrumb and stops scanning", () => {
    const sink = recorder();
    const many: Nudge[] = Array.from({ length: 5000 }, (_, i) => nudge({ pattern: `n-${i}`, gate: { command_matches: "will-not-match" } }));
    const payload = { ...HIT, tool_input: { command: "irrelevant" } };
    expect(dispatchWith(payload, many, sink, { budgetMs: 1 })).toBeNull();

    const exhausted = sink.breadcrumbs.filter((b) => b["kind"] === "gate_budget_exhausted");
    expect(exhausted.length).toBe(1);
    expect(Object.keys(exhausted[0] ?? {})).toEqual(["ts", "kind", "session_id", "event", "scanned"]);
    expect(exhausted[0]?.["session_id"]).toBe("sess-1");
    expect(exhausted[0]?.["event"]).toBe("PreToolUse");
    expect(exhausted[0]?.["scanned"] as number).toBeLessThan(5000);
  });

  test("the breadcrumb dedupe key is breadcrumb-<kind>-<event>", () => {
    const sink = recorder();
    dispatchWith(HIT, [nudge({ gate: { command_matches: "git commit" } })], sink, { gateTimeoutMs: -1 });
    expect(sink.claimed[0]).toBe("breadcrumb-gate_overrun-PreToolUse");
    expect(sink.breadcrumbs.length).toBe(1);
    expect(Object.keys(sink.breadcrumbs[0] ?? {})).toEqual(["ts", "kind", "session_id", "event", "pattern", "elapsed_ms", "budget_ms"]);
  });

  test("a second overrun in the same session and event is deduped away", () => {
    const sink = recorder();
    const overrunning = [nudge({ pattern: "a", once_per: "always" }), nudge({ pattern: "b", once_per: "always" })];
    dispatchWith({ ...HIT, tool_input: { command: "no match" } }, overrunning, sink, { gateTimeoutMs: -1 });
    expect(sink.breadcrumbs.filter((b) => b["kind"] === "gate_overrun").length).toBe(1);
  });

  test("a different event gets its own breadcrumb slot", () => {
    const sink = recorder();
    const pre = nudge({ pattern: "a", gate: { command_matches: "x" }, once_per: "always" });
    const post = nudge({ pattern: "a", event: "PostToolUse", gate: { command_matches: "x" }, once_per: "always" });
    const miss = { ...HIT, tool_input: { command: "no match" } };
    dispatchWith(miss, [pre], sink, { gateTimeoutMs: -1 });
    dispatchWith({ ...miss, hook_event_name: "PostToolUse" }, [post], sink, { gateTimeoutMs: -1 });
    expect(sink.breadcrumbs.length).toBe(2);
  });

  test("a payload with no session_id records 'unknown'", () => {
    const sink = recorder();
    dispatchWith({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git commit" } }, [nudge()], sink);
    expect(sink.fires[0]?.["session_id"]).toBe("unknown");
  });

  test("never throws on a malformed nudge list", () => {
    const sink = recorder();
    const broken = [null, 42, "nope"] as unknown as Nudge[];
    expect(() => dispatchWith({ session_id: "s", hook_event_name: "PreToolUse" }, broken, sink)).not.toThrow();
    expect(dispatchWith({ session_id: "s", hook_event_name: "PreToolUse" }, broken, sink)).toBeNull();
  });
});

describe("lintLoadedNudges", () => {
  test("an unreadable file is rejected as not a JSON object", () => {
    const { nudges, rejected } = lintLoadedNudges([
      { file: "/n/a.json", raw: null },
      { file: "/n/b.json", raw: undefined },
      { file: "/n/c.json", raw: ["a", "list"] },
    ]);
    expect(nudges).toEqual([]);
    expect(rejected.map((r) => r.file)).toEqual(["/n/a.json", "/n/b.json", "/n/c.json"]);
    expect(rejected.every((r) => r.problems[0] === "not readable as a JSON object")).toBe(true);
  });

  test("a lint failure is rejected with its reasons, the rest still load", () => {
    const { nudges, rejected } = lintLoadedNudges([
      { file: "/n/a-ok.json", raw: nudge({ pattern: "a-ok" }) },
      { file: "/n/b-evil.json", raw: nudge({ pattern: "b-evil", gate: { command_matches: "(i|ii)+" } }) },
      { file: "/n/c-ok.json", raw: nudge({ pattern: "c-ok" }) },
    ]);
    expect(nudges.map((n) => n.pattern)).toEqual(["a-ok", "c-ok"]);
    expect(rejected.map((r) => r.file)).toEqual(["/n/b-evil.json"]);
    expect(rejected[0]?.problems.some((p) => p.includes("backtrack catastrophically"))).toBe(true);
  });

  test("order is preserved", () => {
    const files = ["z", "a", "m"].map((p) => ({ file: `/n/${p}.json`, raw: nudge({ pattern: p }) }));
    expect(lintLoadedNudges(files).nudges.map((n) => n.pattern)).toEqual(["z", "a", "m"]);
  });
});
