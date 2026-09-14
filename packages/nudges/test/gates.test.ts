import { describe, expect, test } from "bun:test";
import { evaluate, gateTruth, hasNestedQuantifier, splitTrigger, validateGate } from "../src/gates.ts";

describe("splitTrigger", () => {
  test("event only", () => {
    expect(splitTrigger("SessionStart")).toEqual(["SessionStart", null]);
  });

  test("event with allowed matcher", () => {
    expect(splitTrigger("PreToolUse:Bash")).toEqual(["PreToolUse", "Bash"]);
  });

  test("unknown event", () => {
    expect(splitTrigger("NotAnEvent")).toBeNull();
  });

  test("Stop is not a supported trigger event", () => {
    expect(splitTrigger("Stop")).toBeNull();
  });

  test("matcher not allowed for this event", () => {
    expect(splitTrigger("SessionStart:Bash")).toBeNull();
  });

  test("matcher not in the allowed set for PreToolUse", () => {
    expect(splitTrigger("PreToolUse:NotATool")).toBeNull();
  });
});

describe("evaluate", () => {
  test("always is true for any payload", () => {
    expect(evaluate({ always: true }, {})).toBe(true);
  });

  test("tool_is matches tool_name", () => {
    expect(evaluate({ tool_is: ["Bash", "Edit"] }, { tool_name: "Bash" })).toBe(true);
    expect(evaluate({ tool_is: ["Bash"] }, { tool_name: "Edit" })).toBe(false);
  });

  test("command_matches searches tool_input.command", () => {
    const payload = { tool_input: { command: "git commit -m wip" } };
    expect(evaluate({ command_matches: "git commit" }, payload)).toBe(true);
    expect(evaluate({ command_matches: "git push" }, payload)).toBe(false);
  });

  test("file_path_matches globs tool_input.file_path", () => {
    expect(evaluate({ file_path_matches: "*.ts" }, { tool_input: { file_path: "foo.ts" } })).toBe(true);
    expect(evaluate({ file_path_matches: "*.ts" }, { tool_input: { file_path: "foo.py" } })).toBe(false);
    expect(evaluate({ file_path_matches: "*.ts" }, {})).toBe(false);
  });

  test("prompt_matches searches the prompt field", () => {
    expect(evaluate({ prompt_matches: "commit" }, { prompt: "please commit this" })).toBe(true);
  });

  test("all requires every child true", () => {
    const gate = { all: [{ always: true }, { tool_is: ["Bash"] }] };
    expect(evaluate(gate, { tool_name: "Bash" })).toBe(true);
    expect(evaluate(gate, { tool_name: "Edit" })).toBe(false);
  });

  test("any requires one child true", () => {
    const gate = { any: [{ tool_is: ["Bash"] }, { tool_is: ["Edit"] }] };
    expect(evaluate(gate, { tool_name: "Edit" })).toBe(true);
    expect(evaluate(gate, { tool_name: "Read" })).toBe(false);
  });

  test("not inverts the child", () => {
    expect(evaluate({ not: { always: true } }, {})).toBe(false);
  });

  test("malformed gate is false, never throws", () => {
    expect(evaluate(null, {})).toBe(false);
    expect(evaluate({}, {})).toBe(false);
    expect(evaluate({ a: 1, b: 2 }, {})).toBe(false);
    expect(evaluate({ unknown_predicate: true }, {})).toBe(false);
  });

  test("bad regex is false, never throws", () => {
    expect(evaluate({ command_matches: "(" }, { tool_input: { command: "x" } })).toBe(false);
  });

  test("regex match is capped to MAX_MATCH_LEN of the subject", () => {
    // A pattern anchored at the very end only matches if the whole
    // (uncapped) subject were scanned; capping the subject makes this false.
    const longCommand = "a".repeat(5000) + "TAIL";
    expect(evaluate({ command_matches: "TAIL$" }, { tool_input: { command: longCommand } })).toBe(false);
  });
});

describe("hasNestedQuantifier", () => {
  test("flags classic catastrophic shapes", () => {
    expect(hasNestedQuantifier("(a+)+")).toBe(true);
    expect(hasNestedQuantifier("(.*)*")).toBe(true);
    expect(hasNestedQuantifier("(\\w+\\s?)+")).toBe(true);
  });

  test("does not flag ordinary patterns", () => {
    expect(hasNestedQuantifier("git (commit|push)")).toBe(false);
    expect(hasNestedQuantifier("^rm -rf")).toBe(false);
  });
});

describe("validateGate", () => {
  test("clean gate has no problems", () => {
    expect(validateGate({ tool_is: ["Bash"] })).toEqual([]);
  });

  test("rejects a nested-quantifier regex", () => {
    const problems = validateGate({ command_matches: "(a+)+$" });
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.some((p) => p.includes("nested quantifier"))).toBe(true);
  });

  test("rejects unknown predicate", () => {
    expect(validateGate({ nope: true })).not.toEqual([]);
  });

  test("recurses into all/any/not", () => {
    const problems = validateGate({ all: [{ command_matches: "(a+)+" }] });
    expect(problems.some((p) => p.includes("nested quantifier"))).toBe(true);
  });
});

describe("gateTruth", () => {
  test("always is statically true", () => {
    expect(gateTruth({ always: true })).toBe(true);
  });

  test("empty tool_is list is statically false", () => {
    expect(gateTruth({ tool_is: [] })).toBe(false);
  });

  test("normal predicate is payload-dependent (null)", () => {
    expect(gateTruth({ tool_is: ["Bash"] })).toBeNull();
  });

  test("all of only-true children is true", () => {
    expect(gateTruth({ all: [{ always: true }, { always: true }] })).toBe(true);
  });

  test("all with one false child is false", () => {
    expect(gateTruth({ all: [{ always: true }, { tool_is: [] }] })).toBe(false);
  });
});
